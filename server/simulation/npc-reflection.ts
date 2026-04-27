import { v4 as uuid } from 'uuid'
import {
  getWorld,
  getPlayer,
  addNpcKnowledge,
  updateNpcPlan,
  isNpcBusy,
} from '../game/state.js'
import { llmFunctionCall } from '../llm/client.js'
import { REFLECTION_SCHEMA } from '../llm/schemas.js'
import { getTopMemories } from '../game/state.js'
import { broadcastEvent } from '../routes/events.js'
import type { NPC, WorldState } from '../../shared/types.js'

const REFLECTION_INTERVAL = 12 // ticks between reflections

export async function runReflections(world: WorldState): Promise<void> {
  if (world.currentTick % REFLECTION_INTERVAL !== 0 || world.currentTick === 0) return

  // Pick 2-3 NPCs to reflect (budget control)
  const candidates = world.npcs
    .filter((n) => !isNpcBusy(n.id) && n.physical.status === 'alive')
    .sort(() => Math.random() - 0.5)
    .slice(0, 3)

  for (const npc of candidates) {
    try {
      await reflectNpc(npc, world)
    } catch (err) {
      console.error(`Reflection failed for ${npc.name}:`, err)
    }
  }
}

async function reflectNpc(npc: NPC, world: WorldState): Promise<void> {
  const memories = getTopMemories(npc, world.currentTick)
    .map((k) => `- ${k.content} (${k.source})`)
    .join('\n')

  const agreements = (npc.agreements ?? [])
    .filter((a) => a.active)
    .map((a) => {
      const other = a.withId === 'player' ? 'the visitor' : world.npcs.find((n) => n.id === a.withId)?.name ?? a.withId
      return `- With ${other}: ${a.content}`
    })
    .join('\n')

  const plan = npc.activePlan?.status === 'active'
    ? `Goal: ${npc.activePlan.goal}\nSteps: ${npc.activePlan.steps.map((s) => `${s.status}: ${s.description.slice(0, 40)}`).join(', ')}`
    : 'None'

  const player = getPlayer()
  const playerHere = player.currentLocationId === npc.currentLocationId

  const prompt = `You are the internal mind of ${npc.name} (${npc.occupation}) in a text adventure. Reflect on your situation and decide what to do next.

PERSONALITY: ${npc.personality.traits.join(', ')}
PUBLIC GOAL: ${npc.goals.public}
SECRET GOAL: ${npc.goals.secret}
MOOD: ${npc.mood.current}
STATE: ${npc.stateFlags?.join(', ') || 'normal'}
HEALTH: ${npc.physical.health}/100

WHAT I REMEMBER:
${memories || 'Nothing notable'}

ACTIVE AGREEMENTS:
${agreements || 'None'}

CURRENT PLAN:
${plan}

INVENTORY: ${npc.inventory.map((i) => i.name).join(', ') || 'nothing'}
LOCATION: ${world.locations.find((l) => l.id === npc.currentLocationId)?.name}
${playerHere ? 'The visitor/player is here right now.' : ''}

Based on everything above, reflect briefly and decide:
1. What is my current assessment of the situation?
2. Should I change my plan? (yes/no and why)
3. Should I approach the visitor to talk? (yes/no and why — only if they are here)
4. Any new beliefs or conclusions?

Respond with ONLY JSON:
{
  "reflection": "2-3 sentence internal assessment",
  "should_replan": true or false,
  "approach_player": true or false,
  "approach_reason": "why I want to talk to them" or null,
  "new_belief": "a conclusion I've drawn" or null
}`

  const result = await llmFunctionCall<{
    reflection: string
    should_replan: boolean
    approach_player: boolean
    approach_reason: string | null
    new_belief: string | null
  }>(
    'simulation',
    [{ role: 'system', content: prompt }, { role: 'user', content: 'Reflect now.' }],
    REFLECTION_SCHEMA
  )

  console.log(`[Reflect] ${npc.name}: ${result.reflection.slice(0, 80)}`)

  // Store reflection as high-importance knowledge
  addNpcKnowledge(npc.id, [{
    id: uuid(),
    content: `Self-reflection: ${result.reflection}`,
    source: 'self — reflection',
    confidence: 1.0,
    importance: 0.8,
    turnLearned: world.currentTick,
    isSecret: true,
  }])

  // Store belief
  if (result.new_belief) {
    addNpcKnowledge(npc.id, [{
      id: uuid(),
      content: result.new_belief,
      source: 'self — conclusion',
      confidence: 0.8,
      importance: 0.7,
      turnLearned: world.currentTick,
      isSecret: false,
    }])
  }

  // Trigger replan
  if (result.should_replan) {
    updateNpcPlan(npc.id, null) // clear current plan, activation system will create new one
    console.log(`[Reflect] ${npc.name} decides to replan`)
  }

  // Approach player
  if (result.approach_player && playerHere) {
    broadcastEvent({
      type: 'npc_approaches' as string as 'npc_action',
      data: {
        npcId: npc.id,
        description: result.approach_reason ?? `${npc.name} wants to talk to you.`,
      },
    })
  }
}
