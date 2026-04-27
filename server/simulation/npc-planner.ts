import { v4 as uuid } from 'uuid'
import {
  getWorld,
  getNpc,
  addNpcKnowledge,
  moveNpc,
  getTopMemories,
  applyPhysicalEffects,
  updateNpcRelationship,
  updateNpcPlan,
} from '../game/state.js'
import { llmCall } from '../llm/client.js'
import { judgeAction, searchContainer } from '../llm/judge.js'
import type { GameMasterResult } from '../llm/judge.js'
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

  // Has active agreements to act on?
  const activeAgreements = (npc.agreements ?? []).filter((a) => a.active)
  if (activeAgreements.length > 0 && !npc.activePlan) activation += 0.3

  // Recent significant relationship change (learned about player in last 2 ticks)?
  const recentRelKnowledge = npc.knowledge.filter(
    (k) => k.turnLearned >= world.currentTick - 2 &&
      k.importance >= 0.6 &&
      (k.source.toLowerCase().includes('player') || k.source.toLowerCase().includes('visitor'))
  )
  if (recentRelKnowledge.length > 0) activation += 0.2

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

  // ── Situational awareness: who's here right now ──
  const npcsHere = world.npcs
    .filter((n) => n.id !== npc.id && n.currentLocationId === npc.currentLocationId)
    .map((n) => {
      const rel = npc.relationships.find((r) => r.targetNpcId === n.id)
      const feeling = rel
        ? `(${rel.type}, ${rel.trust > 20 ? 'trust' : rel.trust < -20 ? 'distrust' : 'neutral'})`
        : '(stranger)'
      const stateStr = (n.stateFlags?.length ?? 0) > 0 ? ` {${n.stateFlags.join(', ')}}` : ''
      return `${n.name} (${n.occupation}) ${feeling} [${n.physical.status}, hp:${n.physical.health}]${stateStr}`
    })
    .join('\n  ')

  // ── Role-based world knowledge: what this NPC would know ──
  const locationDetails = world.locations.map((loc) => {
    const security = loc.securityLevel > 0 ? ` [SECURITY: ${loc.securityLevel}/5]` : ''
    const containers = loc.containers
      .filter((c) => (c.searchCount ?? 0) === 0 || (world.currentTick - (c.lastSearchTick ?? 0) >= 6))
      .map((c) => c.name)
    const containerStr = containers.length > 0 ? ` — searchable: ${containers.join(', ')}` : ''
    const fixtures = loc.fixtures.length > 0 ? ` — has: ${loc.fixtures.join(', ')}` : ''
    const npcsAt = world.npcs
      .filter((n) => n.id !== npc.id && n.currentLocationId === loc.id)
      .map((n) => n.name)
    const whosThere = npcsAt.length > 0 ? ` — people: ${npcsAt.join(', ')}` : ''

    // Filter detail by occupation relevance
    const isRelevant = npc.occupationTags.some((tag) =>
      loc.tags.some((lt) => lt.includes(tag) || tag.includes(lt))
    ) || loc.type === 'workshop' || loc.type === 'tavern'

    const detail = isRelevant ? `${containerStr}${fixtures}` : ''

    return `  ${loc.id}: ${loc.name} (${loc.type})${security}${detail}${whosThere}`
  }).join('\n')

  // ── Known people on the station ──
  const knownPeople = world.npcs
    .filter((n) => n.id !== npc.id)
    .map((n) => {
      const rel = npc.relationships.find((r) => r.targetNpcId === n.id)
      if (rel) {
        return `${n.name} (${n.occupation}): ${rel.type}, trust:${rel.trust}, affection:${rel.affection}`
      }
      return `${n.name} (${n.occupation}): no relationship`
    })
    .join('\n  ')

  // ── Current location detail ──
  const currentLocDetail = location
    ? `${location.name} (${location.type}). ${location.description}
  Fixtures: ${location.fixtures.join(', ') || 'none'}
  Unsearched containers: ${location.containers.filter((c) => (c.searchCount ?? 0) === 0 || (world.currentTick - (c.lastSearchTick ?? 0) >= 6)).map((c) => c.name).join(', ') || 'none'}
  Security level: ${location.securityLevel}/5`
    : 'unknown'

  const prompt = `You are a planning engine for an NPC in a text adventure. Given their goals, knowledge, skills, and awareness of the world, create a concrete, grounded plan.

CHARACTER:
  Name: ${npc.name}, ${npc.age}-year-old ${npc.occupation}
  Skills: ${npc.occupationTags.join(', ')}
  Personality: ${npc.personality.traits.join(', ')}
  Public goal: ${npc.goals.public}
  Secret goal: ${npc.goals.secret}
  Mood: ${npc.mood.current}
  Health: ${npc.physical.health}/100 ${npc.physical.injuries.length > 0 ? `(injuries: ${npc.physical.injuries.join(', ')})` : ''}
  Inventory: ${npc.inventory.map((i) => `${i.name} [${i.tags.join(',')}]`).join(', ') || 'nothing'}

CURRENT LOCATION:
  ${currentLocDetail}

PEOPLE HERE RIGHT NOW:
  ${npcsHere || 'nobody'}

WHAT ${npc.name.toUpperCase()} KNOWS:
  ${topMemories || 'nothing notable'}

ALL KNOWN PEOPLE:
  ${knownPeople}

ALL LOCATIONS:
${locationDetails}

HOW THE WORLD WORKS:
- You can SEARCH containers to find items. Workshops have tools, labs have equipment, kitchens have food/poison.
- You NEED the right items for certain actions. To cut a door, you need a cutting tool. To poison someone, you need poison. PLAN to acquire items first.
- When you TARGET another NPC (recruit, confront, charm, attack), you will actually talk to or interact with them. They will react and may resist.
- WITNESSES at your location will see what you do. Plan stealthy actions when alone.
- Actions have CONSEQUENCES: attacking hurts health, stealing damages trust, helping builds relationships.
- You can GIVE items to other NPCs or DROP items at locations.
- Travel between locations takes time. Plan your route.
- High-security areas (level 3+) are hard to access without keycards or skills.

INSTRUCTIONS:
- Create a plan with 2-6 concrete steps to pursue your secret goal.
- Actions can be ANYTHING: search, travel, recruit, charm, intimidate, fight, sabotage, steal, heal, build, observe, confront, seduce, deceive, hide, share_info, use_item, give_item, drop_item, barricade, sneak, repair, hack, lockpick, bribe, threaten, poison, ambush, etc.
- THINK ABOUT PREREQUISITES: if you need an item, add a "search" step BEFORE the step that uses it.
- Choose the right action for the situation. A good plan mixes social and physical actions.
- Use real location IDs (loc_X) for travel targets.
- Use real NPC names for social targets.
- Consider who you trust, who might help, who might oppose you.
- Consider what items you already have and what you still need.
- Consider security levels — high-security areas need preparation.
- Be realistic about your skills. A scientist shouldn't plan to fight a guard.
- If your plan involves another person, include a step to TALK to them first.
- Your personality should influence your approach (cautious vs bold, honest vs deceptive).

Respond with ONLY JSON:
{
  "goal": "what you're trying to achieve",
  "motivation": "why (1 sentence)",
  "steps": [
    { "action": "action_type", "target": "loc_id or npc_name or item", "description": "Concrete description of what you do and why" }
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
    case 'observe':
      result = executeObserve(npc, currentStep, world)
      break
    default:
      // UNIVERSAL HANDLER: route ALL other actions through Game Master
      // This covers: recruit, confront, poison, steal, charm, sabotage,
      // fight, heal, lockpick, use_item, share_info, and anything else
      result = await executeAttempt(npc, currentStep, world)
      break
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

  // Persist plan state changes through proper state management
  updateNpcPlan(npc.id, npc.activePlan)

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
  const unsearched = location.containers.find((c) => (c.searchCount ?? 0) === 0 || (world.currentTick - (c.lastSearchTick ?? 0) >= 6))
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

  const item = await searchContainer(npc, location, unsearched.id, world.currentTick)

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

  // Find target NPC if this action targets one
  const targetNpc = world.npcs.find((n) =>
    n.id === step.target ||
    n.name.toLowerCase().includes(step.target.toLowerCase()) ||
    step.target.toLowerCase().includes(n.name.toLowerCase())
  )

  const result = await judgeAction({
    actor: {
      name: npc.name,
      occupation: npc.occupation,
      tags: npc.occupationTags,
      health: npc.physical.health,
      injuries: npc.physical.injuries,
    },
    action: step.description,
    target: {
      name: targetNpc?.name ?? step.target,
      tags: targetNpc?.occupationTags ?? [],
      health: targetNpc?.physical.health,
    },
    environment: { name: location?.name ?? 'unknown', tags: location?.tags ?? [] },
    context: `${npc.name} is attempting: ${step.description}. Inventory: ${npc.inventory.map((i) => i.name).join(', ') || 'nothing'}. ${targetNpc ? `Target ${targetNpc.name} is ${targetNpc.physical.status}, health ${targetNpc.physical.health}/100.` : ''}`,
  })

  // Apply physical effects
  const gmResult = result as GameMasterResult
  if (gmResult.effects) {
    applyPhysicalEffects(npc.id, {
      healthDelta: gmResult.effects.actorHealthDelta,
      energyDelta: gmResult.effects.actorEnergyDelta,
      injury: gmResult.effects.actorInjury,
      statusChange: gmResult.effects.actorStatusChange,
    })
    if (targetNpc) {
      applyPhysicalEffects(targetNpc.id, {
        healthDelta: gmResult.effects.targetHealthDelta,
        injury: gmResult.effects.targetInjury,
        statusChange: gmResult.effects.targetStatusChange,
      })
      if (gmResult.effects.relationshipImpact !== 0) {
        updateNpcRelationship(npc.id, targetNpc.id, {
          affection: gmResult.effects.relationshipImpact,
          trust: gmResult.effects.relationshipImpact,
        })
      }

      // Target NPC becomes aware of what happened
      addNpcKnowledge(targetNpc.id, [{
        id: uuid(),
        content: `${npc.name} ${result.outcome === 'failure' ? 'tried to' : 'successfully'} ${step.description} ${result.outcome !== 'failure' ? '— it worked' : '— but failed'}. ${result.narrativeHint}`,
        source: 'experienced',
        confidence: 1.0,
        importance: 0.9,
        turnLearned: world.currentTick,
        isSecret: false,
      }])

      // Witnesses at the same location also learn about it
      const witnesses = world.npcs.filter((n) =>
        n.id !== npc.id && n.id !== targetNpc.id && n.currentLocationId === npc.currentLocationId
      )
      for (const witness of witnesses) {
        addNpcKnowledge(witness.id, [{
          id: uuid(),
          content: `Witnessed ${npc.name} ${step.action} ${targetNpc.name}. ${result.narrativeHint}`,
          source: 'witnessed',
          confidence: 0.9,
          importance: 0.7,
          turnLearned: world.currentTick,
          isSecret: false,
        }])
      }
    }
  }

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

  // On strong success, trigger discovery
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
  // Dead or unconscious NPCs can't act
  if (npc.physical.status === 'dead' || npc.physical.status === 'unconscious') {
    return { action: `${npc.physical.status}`, llmCalls: 0 }
  }

  // Restrained NPCs can only plan escape, not execute other steps
  if (npc.physical.status === 'restrained' && npc.activePlan?.goal?.toLowerCase().includes('escape') === false) {
    return { action: 'restrained', llmCalls: 0 }
  }

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
      updateNpcPlan(npc.id, plan)
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
