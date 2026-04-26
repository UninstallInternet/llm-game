import { v4 as uuid } from 'uuid'
import {
  getWorld,
  getNpc,
  addNpcKnowledge,
  moveNpc,
  getTopMemories,
} from '../game/state.js'
import { llmCall } from '../llm/client.js'
import { judgeAction, preCheckAction, searchContainer } from '../llm/judge.js'
import { generateDiscovery } from './discovery.js'
import { broadcastEvent } from '../routes/events.js'
import {
  ACTIVATION_THRESHOLD_LOW,
  ACTIVATION_THRESHOLD_HIGH,
  MEMORY_DECAY_RATE,
} from '../../shared/constants.js'
import type { NPC, WorldState, NpcPlan, PlanStep, Item } from '../../shared/types.js'

// ─── Activation Energy ───

export function calculateActivation(npc: NPC, world: WorldState): number {
  let activation = 0

  // Has unmet goals? (secret goal always drives action)
  if (npc.goals.secret) activation += 0.2

  // Has new important knowledge (learned in last 3 ticks)?
  const recentImportant = npc.knowledge.filter(
    (k) => k.turnLearned >= world.currentTick - 3 && k.importance > 0.5
  )
  activation += Math.min(recentImportant.length * 0.1, 0.3)

  // Active plan disrupted?
  if (npc.activePlan?.status === 'active') {
    const failedSteps = npc.activePlan.steps.filter((s) => s.status === 'failed')
    if (failedSteps.length > 0) activation += 0.2
  }

  // No plan but has goals?
  if (!npc.activePlan && npc.goals.secret) activation += 0.15

  // Personality modifier: ambitious NPCs are more active
  if (npc.personality.traits.some((t) => t.includes('ambitious') || t.includes('curious') || t.includes('restless'))) {
    activation += 0.1
  }

  return Math.min(1.0, activation)
}

// ─── Plan Formation ───

export async function formPlan(npc: NPC, world: WorldState): Promise<NpcPlan | null> {
  const location = world.locations.find((l) => l.id === npc.currentLocationId)
  const topMemories = getTopMemories(npc, world.currentTick)
    .filter((k) => !k.isSecret)
    .slice(0, 5)
    .map((k) => k.content)
    .join('\n- ')

  const nearbyNpcs = world.npcs
    .filter((n) => n.id !== npc.id && n.currentLocationId === npc.currentLocationId)
    .map((n) => `${n.name} (${n.occupation})`)
    .join(', ')

  const knownLocations = world.locations
    .map((l) => `${l.id}: ${l.name} (${l.type})`)
    .join('\n')

  const prompt = `You are a planning engine for an NPC in a text adventure game. Given the NPC's goals, knowledge, and situation, create a concrete plan of action.

NPC: ${npc.name}, ${npc.occupation}
Location: ${location?.name ?? 'unknown'}
Public goal: ${npc.goals.public}
Secret goal: ${npc.goals.secret}
Mood: ${npc.mood.current}
Inventory: ${npc.inventory.map((i) => i.name).join(', ') || 'nothing'}
Occupation skills: ${npc.occupationTags.join(', ')}

What ${npc.name} knows:
- ${topMemories || 'nothing notable'}

Nearby: ${nearbyNpcs || 'nobody'}

Available locations:
${knownLocations}

Create a plan with 2-6 concrete steps. Each step must be one of: search, travel, recruit, use_item, attempt_objective, observe, confront, share_info.
The plan should be achievable and grounded — no magic or impossible technology.

Respond with ONLY JSON (no markdown):
{
  "goal": "what the NPC is trying to achieve",
  "motivation": "why (1 sentence)",
  "steps": [
    { "action": "travel", "target": "loc_id", "description": "Go to the workshop to find tools" },
    { "action": "search", "target": "loc_id", "description": "Search for a cutting tool" },
    { "action": "recruit", "target": "npc_id or name", "description": "Ask the engineer for help" },
    { "action": "attempt_objective", "target": "description", "description": "Try to open the sealed door" }
  ]
}`

  try {
    const raw = await llmCall('simulation', prompt, 'Create a plan.', true)
    let cleaned = raw.trim()
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
    }

    const parsed = JSON.parse(cleaned) as {
      goal: string
      motivation: string
      steps: Array<{ action: string; target: string; description: string }>
    }

    const plan: NpcPlan = {
      id: uuid(),
      goal: parsed.goal,
      motivation: parsed.motivation,
      steps: parsed.steps.slice(0, 8).map((s) => ({
        action: s.action as PlanStep['action'],
        target: s.target,
        description: s.description,
        status: 'pending',
      })),
      allies: [],
      status: 'active',
      formedAtTick: world.currentTick,
    }

    // Mark first step as active
    if (plan.steps.length > 0) {
      plan.steps[0].status = 'active'
    }

    return plan
  } catch (error) {
    console.error(`Plan formation failed for ${npc.name}:`, error)
    return null
  }
}

// ─── Step Execution ───

export async function executeCurrentStep(
  npc: NPC,
  world: WorldState
): Promise<{ executed: boolean; description: string }> {
  if (!npc.activePlan || npc.activePlan.status !== 'active') {
    return { executed: false, description: 'No active plan' }
  }

  const currentStep = npc.activePlan.steps.find((s) => s.status === 'active')
  if (!currentStep) {
    // All steps done or none active — complete the plan
    npc.activePlan.status = 'completed'
    return { executed: false, description: 'Plan completed' }
  }

  let result: { executed: boolean; description: string }

  switch (currentStep.action) {
    case 'travel':
      result = executeTravel(npc, currentStep, world)
      break
    case 'search':
      result = await executeSearch(npc, currentStep, world)
      break
    case 'attempt_objective':
      result = await executeAttempt(npc, currentStep, world)
      break
    case 'observe':
      result = executeObserve(npc, currentStep, world)
      break
    case 'recruit':
    case 'confront':
    case 'share_info':
      // These require conversations — mark as pending for conversation system
      result = { executed: true, description: `${npc.name} wants to talk to someone about: ${currentStep.description}` }
      currentStep.status = 'completed'
      currentStep.result = 'Initiated social action'
      break
    case 'use_item':
      result = await executeUseItem(npc, currentStep, world)
      break
    default:
      result = { executed: false, description: `Unknown action: ${currentStep.action}` }
      currentStep.status = 'failed'
  }

  // Advance to next step if current completed
  if (currentStep.status === 'completed') {
    const nextPending = npc.activePlan.steps.find((s) => s.status === 'pending')
    if (nextPending) {
      nextPending.status = 'active'
    } else {
      npc.activePlan.status = 'completed'
      broadcastEvent({
        type: 'npc_plan',
        data: { npcId: npc.id, goal: npc.activePlan.goal, status: 'completed', stepCount: npc.activePlan.steps.length },
      })
    }
  }

  return result
}

function executeTravel(npc: NPC, step: PlanStep, world: WorldState): { executed: boolean; description: string } {
  const targetLocId = step.target
  const targetLoc = world.locations.find((l) => l.id === targetLocId || l.name.toLowerCase().includes(targetLocId.toLowerCase()))

  if (!targetLoc) {
    step.status = 'failed'
    step.result = 'Location not found'
    return { executed: false, description: `${npc.name} couldn't find the location` }
  }

  // Check if already there
  if (npc.currentLocationId === targetLoc.id) {
    step.status = 'completed'
    step.result = 'Already at location'
    return { executed: true, description: `${npc.name} is already at ${targetLoc.name}` }
  }

  // Move NPC
  const fromLoc = npc.currentLocationId
  moveNpc(npc.id, targetLoc.id)
  step.status = 'completed'
  step.result = `Traveled to ${targetLoc.name}`

  broadcastEvent({
    type: 'npc_moved',
    data: { npcId: npc.id, fromLocationId: fromLoc, toLocationId: targetLoc.id },
  })

  return { executed: true, description: `${npc.name} travels to ${targetLoc.name}` }
}

async function executeSearch(npc: NPC, step: PlanStep, world: WorldState): Promise<{ executed: boolean; description: string }> {
  const location = world.locations.find((l) => l.id === npc.currentLocationId)
  if (!location) {
    step.status = 'failed'
    return { executed: false, description: 'Not at a valid location' }
  }

  // Find an unsearched container
  const unsearched = location.containers.find((c) => !c.searched)
  if (!unsearched) {
    step.status = 'completed'
    step.result = 'Nothing more to search here'
    addNpcKnowledge(npc.id, [{
      id: uuid(),
      content: `Searched ${location.name} thoroughly — nothing useful found.`,
      source: 'observed',
      confidence: 0.9,
      importance: 0.3,
      turnLearned: world.currentTick,
      isSecret: false,
    }])
    return { executed: true, description: `${npc.name} searches ${location.name} but finds nothing new` }
  }

  const item = await searchContainer(npc, location, unsearched.id)

  if (item) {
    npc.inventory.push(item)
    step.status = 'completed'
    step.result = `Found ${item.name}`

    addNpcKnowledge(npc.id, [{
      id: uuid(),
      content: `Found a ${item.name} in the ${unsearched.name} at ${location.name}.`,
      source: 'observed',
      confidence: 1.0,
      importance: 0.7,
      turnLearned: world.currentTick,
      isSecret: false,
    }])

    broadcastEvent({
      type: 'item_found',
      data: { npcId: npc.id, itemName: item.name, locationId: location.id },
    })

    return { executed: true, description: `${npc.name} searches the ${unsearched.name} and finds a ${item.name}!` }
  }

  step.result = 'Searched but found nothing useful'
  // Don't fail — let them try again next tick or move on
  return { executed: true, description: `${npc.name} searches the ${unsearched.name} but finds nothing useful` }
}

async function executeAttempt(npc: NPC, step: PlanStep, world: WorldState): Promise<{ executed: boolean; description: string }> {
  const location = world.locations.find((l) => l.id === npc.currentLocationId)

  const result = await judgeAction({
    actor: { name: npc.name, occupation: npc.occupation, tags: npc.occupationTags },
    action: step.description,
    target: { name: step.target, tags: [] },
    environment: { name: location?.name ?? 'unknown', tags: location?.tags ?? [] },
    context: `${npc.name} is attempting: ${step.description}. Inventory: ${npc.inventory.map((i) => i.name).join(', ') || 'nothing'}`,
  })

  step.result = `${result.outcome}: ${result.narrativeHint}`

  broadcastEvent({
    type: 'npc_action_result',
    data: {
      npcId: npc.id,
      action: step.description,
      outcome: result.outcome,
      description: result.narrativeHint,
    },
  })

  if (result.outcome === 'failure') {
    step.status = 'failed'
    addNpcKnowledge(npc.id, [{
      id: uuid(),
      content: `Failed to ${step.description}. ${result.narrativeHint}`,
      source: 'observed',
      confidence: 1.0,
      importance: 0.6,
      turnLearned: world.currentTick,
      isSecret: false,
    }])
    return { executed: true, description: `${npc.name} tries to ${step.description} — ${result.narrativeHint}` }
  }

  step.status = 'completed'
  addNpcKnowledge(npc.id, [{
    id: uuid(),
    content: `Successfully ${step.description}. ${result.narrativeHint}`,
    source: 'observed',
    confidence: 1.0,
    importance: 0.8,
    turnLearned: world.currentTick,
    isSecret: false,
  }])

  // On strong success of an attempt_objective, trigger discovery
  if (result.outcome === 'strong_success' && location) {
    console.log(`[Discovery] ${npc.name} triggers discovery at ${location.name}`)
    await generateDiscovery(npc, location, step.description, world)
  }

  return { executed: true, description: `${npc.name} ${step.description} — ${result.narrativeHint}` }
}

async function executeUseItem(npc: NPC, step: PlanStep, world: WorldState): Promise<{ executed: boolean; description: string }> {
  // Find the item in inventory
  const item = npc.inventory.find((i) =>
    i.name.toLowerCase().includes(step.target.toLowerCase()) ||
    step.target.toLowerCase().includes(i.name.toLowerCase())
  )

  if (!item) {
    step.status = 'failed'
    step.result = 'Item not in inventory'
    return { executed: false, description: `${npc.name} doesn't have the required item` }
  }

  return executeAttempt(npc, { ...step, description: `${step.description} using ${item.name}` }, world)
}

function executeObserve(npc: NPC, step: PlanStep, world: WorldState): { executed: boolean; description: string } {
  const location = world.locations.find((l) => l.id === npc.currentLocationId)
  const npcsHere = world.npcs
    .filter((n) => n.id !== npc.id && n.currentLocationId === npc.currentLocationId)
    .map((n) => n.name)

  const observation = `At ${location?.name ?? 'unknown'}: ${npcsHere.length > 0 ? `${npcsHere.join(', ')} are here` : 'nobody around'}. ${location?.description ?? ''}`

  addNpcKnowledge(npc.id, [{
    id: uuid(),
    content: observation,
    source: 'observed',
    confidence: 1.0,
    importance: 0.4,
    turnLearned: world.currentTick,
    isSecret: false,
  }])

  step.status = 'completed'
  step.result = observation

  return { executed: true, description: `${npc.name} observes the surroundings` }
}

// ─── Public: Process One NPC's Turn ───

export async function processNpcTurn(
  npc: NPC,
  world: WorldState
): Promise<{ action: string; llmCalls: number }> {
  const activation = calculateActivation(npc, world)

  // Low activation — do nothing
  if (activation < ACTIVATION_THRESHOLD_LOW) {
    return { action: 'routine', llmCalls: 0 }
  }

  // Has active plan — execute next step
  if (npc.activePlan?.status === 'active') {
    const result = await executeCurrentStep(npc, world)
    if (result.executed) {
      broadcastEvent({
        type: 'npc_action',
        data: { npcId: npc.id, description: result.description },
      })
    }
    // Count LLM calls: search and attempt use 1 each, travel/observe use 0
    const step = npc.activePlan?.steps.find((s) => s.status === 'active' || s.status === 'completed')
    const usedLlm = step?.action === 'search' || step?.action === 'attempt_objective' || step?.action === 'use_item'
    return { action: result.description, llmCalls: usedLlm ? 1 : 0 }
  }

  // High activation, no plan — form one
  if (activation >= ACTIVATION_THRESHOLD_HIGH) {
    const plan = await formPlan(npc, world)
    if (plan) {
      npc.activePlan = plan
      console.log(`[NPC Plan] ${npc.name}: "${plan.goal}" (${plan.steps.length} steps)`)
      broadcastEvent({
        type: 'npc_plan',
        data: { npcId: npc.id, goal: plan.goal, status: 'active', stepCount: plan.steps.length },
      })
      return { action: `Formed plan: ${plan.goal}`, llmCalls: 1 }
    }
  }

  // Medium activation — internal monologue (no LLM, just a thought)
  return { action: 'thinking', llmCalls: 0 }
}
