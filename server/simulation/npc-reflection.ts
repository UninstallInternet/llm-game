import { v4 as uuid } from 'uuid'
import {
  getWorld,
  getPlayer,
  addNpcKnowledge,
  removeOldKnowledge,
  updateNpcPlan,
  isNpcBusy,
  getNpc,
} from '../game/state.js'
import { llmFunctionCall } from '../llm/client.js'
import { REFLECTION_SCHEMA, MEMORY_CONSOLIDATION_SCHEMA } from '../llm/schemas.js'
import { getTopMemories } from '../game/state.js'
import { broadcastEvent } from '../routes/events.js'
import type { NPC, WorldState } from '../../shared/types.js'

const REFLECTION_INTERVAL = 8 // ticks between periodic reflections

// Check if an NPC should reflect immediately due to significant events
export function shouldReflectImmediately(npc: NPC, world: WorldState): boolean {
  const recentCritical = npc.knowledge.filter((k) =>
    k.turnLearned >= world.currentTick - 1 &&
    k.importance >= 0.7 &&
    (k.source.includes('experienced') || k.source.includes('agreement'))
  )
  // Already reflected very recently? Skip
  const recentlyReflected = npc.knowledge.some((k) =>
    k.source === 'self — reflection' && k.turnLearned >= world.currentTick - 2
  )
  if (recentlyReflected) return false

  return (
    recentCritical.length >= 2 ||
    npc.activePlan?.status === 'completed' ||
    (npc.physical.health < 40 && npc.knowledge.some((k) => k.source === 'experienced' && k.turnLearned >= world.currentTick - 1))
  )
}

export async function runReflections(world: WorldState): Promise<void> {
  // Event-driven reflections — NPCs who just experienced something significant
  let eventReflections = 0
  for (const npc of world.npcs) {
    if (eventReflections >= 2) break // budget cap
    if (isNpcBusy(npc.id) || npc.physical.status !== 'alive') continue
    if (shouldReflectImmediately(npc, world)) {
      try {
        await reflectNpc(npc, world)
        eventReflections++
        console.log(`[Reflect-Event] ${npc.name} reflected due to significant event`)
      } catch (err) {
        console.error(`Event reflection failed for ${npc.name}:`, err)
      }
    }
  }

  // Periodic reflections — every N ticks for background NPCs
  if (world.currentTick % REFLECTION_INTERVAL !== 0 || world.currentTick === 0) return

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
    ? (() => {
        const steps = npc.activePlan!.steps
        const failedCount = steps.filter((s) => s.status === 'failed').length
        const doneCount = steps.filter((s) => s.status === 'completed').length
        return `Goal: ${npc.activePlan!.goal}\nProgress: ${doneCount} done, ${failedCount} failed out of ${steps.length}\nSteps: ${steps.map((s) => `${s.status}: ${s.description.slice(0, 40)}`).join(', ')}${failedCount >= 2 ? '\nWARNING: Multiple steps have failed. Consider whether this plan is still viable.' : ''}`
      })()
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

// ─── Memory Consolidation ───
// Compresses oldest memories into summaries when knowledge is getting full

export async function consolidateMemories(world: WorldState): Promise<void> {
  if (world.currentTick % 20 !== 0 || world.currentTick === 0) return

  for (const npc of world.npcs) {
    if (npc.knowledge.length < 100) continue // only when getting full
    if (npc.physical.status === 'dead') continue

    try {
      // Take the 30 oldest entries
      const sorted = [...npc.knowledge].sort((a, b) => a.turnLearned - b.turnLearned)
      const oldest = sorted.slice(0, 30)
      const oldestContent = oldest.map((k) => `- ${k.content} (source: ${k.source}, importance: ${k.importance})`).join('\n')

      const prompt = `You are consolidating an NPC's oldest memories into key summary facts. The NPC is ${npc.name} (${npc.occupation}).

These are their 30 oldest memories (from earliest experiences):
${oldestContent}

Summarize these into 5-8 KEY FACTS that preserve:
- The most important events and discoveries
- Key relationships formed or changed
- Critical information learned
- Any agreements or commitments made

Each fact should be 1-2 sentences. Discard trivial observations like "searched X but found nothing" or "the visitor waited."`

      const result = await llmFunctionCall<{ summaries: string[] }>(
        'simulation',
        [{ role: 'system', content: prompt }, { role: 'user', content: 'Consolidate these memories.' }],
        MEMORY_CONSOLIDATION_SCHEMA
      )

      if (result.summaries && result.summaries.length > 0) {
        // Remove the 30 old entries
        removeOldKnowledge(npc.id, oldest.map((k) => k.id))

        // Add consolidated summaries with high importance
        addNpcKnowledge(npc.id, result.summaries.map((s) => ({
          id: uuid(),
          content: s,
          source: 'consolidated memory',
          confidence: 1.0,
          importance: 0.8,
          turnLearned: world.currentTick,
          isSecret: false,
        })))

        console.log(`[Consolidate] ${npc.name}: 30 memories → ${result.summaries.length} summaries`)
      }
    } catch (err) {
      console.error(`Memory consolidation failed for ${npc.name}:`, err)
    }
  }
}
