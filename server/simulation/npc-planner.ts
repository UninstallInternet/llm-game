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
  completeAgreement,
  persistGame,
  updateNpcStateFlags,
} from '../game/state.js'
import { llmFunctionCall } from '../llm/client.js'
import { PLAN_SCHEMA } from '../llm/schemas.js'
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

  // Secret goal ALWAYS drives action — this is the primary motivation
  if (npc.goals.secret) activation += 0.3

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

  // No plan but has goals? (includes completed plans — should replan)
  if (!npc.activePlan && npc.goals.secret) activation += 0.2
  if (npc.activePlan?.status === 'completed' || npc.activePlan?.status === 'abandoned') activation += 0.25

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
      return `${n.name} (${n.occupation}) ${feeling} [${n.physical?.status ?? 'alive'}, hp:${n.physical?.health ?? 100}]${stateStr}`
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
      const sameLocation = n.currentLocationId === npc.currentLocationId ? ' [HERE NOW]' : ''
      const statusStr = n.physical.status !== 'alive' ? ` [${n.physical.status}]` : ''
      const tagStr = (n.stateFlags ?? []).length > 0 ? ` {${n.stateFlags.join(', ')}}` : ''
      if (rel) {
        const threat = (rel.type === 'enemy' || rel.type === 'rival') ? ' HOSTILE' : (rel.type === 'friend' || rel.trust > 50) ? ' ALLY' : ''
        return `${n.name} (${n.occupation}): ${rel.type}, trust:${rel.trust}${threat}${sameLocation}${statusStr}${tagStr}`
      }
      // Check faction — different faction = potential enemy
      const differentFaction = npc.factionId && n.factionId && npc.factionId !== n.factionId
      const factionLabel = differentFaction ? ' ⚔ ENEMY FACTION' : ''
      return `${n.name} (${n.occupation}): no relationship${factionLabel}${sameLocation}${statusStr}${tagStr}`
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
  Health: ${npc.physical?.health ?? 100}/100 ${(npc.physical?.injuries?.length ?? 0) > 0 ? `(injuries: ${npc.physical!.injuries.join(', ')})` : ''}
  Status: ${npc.physical.status}${(npc.stateFlags ?? []).length > 0 ? ` [${npc.stateFlags.join(', ')}]` : ''}
${(() => {
    const flags = npc.stateFlags ?? []
    const warnings: string[] = []
    if (flags.some((f) => ['restrained', 'tied_up', 'sleeping', 'unconscious'].includes(f))) {
      warnings.push('You are IMMOBILIZED. You CANNOT travel or take physical actions. You CAN only talk, shout, beg, or persuade. Plan to get freed.')
    }
    if ((flags.includes('injured') || flags.includes('bleeding')) && npc.physical.health < 60) {
      warnings.push('You are SERIOUSLY INJURED. Seek healing, bandages, or retreat. Your combat effectiveness is heavily reduced.')
    }
    if (flags.includes('scared')) {
      warnings.push('You are SCARED. You should avoid confrontation and consider fleeing, hiding, or seeking allies for protection.')
    }
    if (flags.includes('armed')) {
      warnings.push('You are ARMED. You have a significant advantage in combat. Use it if needed.')
    }
    if (flags.includes('drunk')) {
      warnings.push('You are DRUNK. Your coordination and judgment are impaired. Avoid precision tasks.')
    }
    if (npc.physical.health < 20) {
      warnings.push('CRITICAL: You are near death. Retreat, find a healer, or hide immediately.')
    } else if (npc.physical.health < 40) {
      warnings.push('Your health is dangerously low. Seek healing before fighting again.')
    }
    return warnings.length > 0 ? `  YOUR CONDITION:\n  ${warnings.join('\n  ')}` : ''
  })()}
  Inventory: ${(npc.inventory ?? []).map((i) => `${i.name} [${(i.tags ?? []).join(',')}]`).join(', ') || 'nothing'}

CURRENT LOCATION:
  ${currentLocDetail}

PEOPLE HERE RIGHT NOW:
  ${npcsHere || 'nobody'}

WHAT ${npc.name.toUpperCase()} KNOWS:
  ${topMemories || 'nothing notable'}

${(() => {
    const activeAgreements = (npc.agreements ?? []).filter((a) => a.active)
    if (activeAgreements.length === 0) return ''
    const lines = activeAgreements.map((a) => {
      const other = a.withId === 'player' ? 'the visitor' : world.npcs.find((n) => n.id === a.withId)?.name ?? a.withId
      const ticksAgo = world.currentTick - (a.madeAtTick ?? 0)
      return `- With ${other} (${ticksAgo} ticks ago): ${a.content}`
    }).join('\n')
    return `ACTIVE COMMITMENTS YOU MUST HONOR:
${lines}
Your plan MUST include steps to fulfill these commitments. Integrate them with your secret goal — pursue BOTH.`
  })()}

ALL KNOWN PEOPLE:
  ${knownPeople}

ALL LOCATIONS:
${locationDetails}

${(() => {
    // Detect hostile NPCs and add combat context
    const enemies = world.npcs.filter((n) => {
      if (n.id === npc.id) return false
      const rel = npc.relationships.find((r) => r.targetNpcId === n.id)
      if (rel && (rel.type === 'enemy' || rel.type === 'rival' || rel.trust < -30)) return true
      if (npc.factionId && n.factionId && npc.factionId !== n.factionId) return true
      return false
    })
    if (enemies.length > 0) {
      return `ENEMIES (you should FIGHT or SABOTAGE these people, not talk to them):
${enemies.map((e) => `  - ${e.name} (${e.occupation}) at ${world.locations.find((l) => l.id === e.currentLocationId)?.name ?? '?'} [HP:${e.physical.health}]`).join('\n')}
If you encounter an enemy, your plan should include ATTACK, AMBUSH, or FIGHT steps. Do NOT try to negotiate with mortal enemies.
`
    }
    return ''
  })()}
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
- Actions can be ANYTHING: search, travel, recruit, charm, intimidate, fight, sabotage, steal, heal, build, observe, confront, seduce, deceive, hide, share_info, use_item, give_item, drop_item, barricade, sneak, repair, hack, lockpick, bribe, threaten, poison, ambush, attack, kill, knock_out, restrain, etc.
- THINK ABOUT PREREQUISITES: if you need an item, add a "search" step BEFORE the step that uses it.
- Choose the right action for the situation. If you are enemies with someone, you might ATTACK them, not talk. If the situation is dangerous, you might FIGHT or FLEE, not negotiate.
- Use real location IDs (loc_X) for travel targets.
- ALWAYS use specific NPC names in step targets and descriptions. NEVER say "others", "everyone", "other succubi", "the group". Say "Emberlyn Ashfire" or "Selene Moonshade". The system needs exact names to execute steps.
- Consider who you trust, who might help, who might oppose you. ENEMIES should be fought, ALLIES should be recruited.
- Consider what items you already have and what you still need.
- Consider security levels — high-security areas need preparation.
- Be realistic about your skills but also about the situation. A warrior seeing an enemy should fight, not negotiate. A spy should sneak, not confront openly.
- Your personality should influence your approach (cautious vs bold, honest vs deceptive, violent vs peaceful).
- NEVER create passive steps like "wait", "hope", "think about it", "see what happens". Every step must be a concrete ACTION you perform.
- If the setting is violent (war, battle, siege, combat), your plan should include COMBAT actions: attack, ambush, fight, kill. Do NOT default to talking when violence is called for.
- If a previous plan was completed, create a NEW plan that builds on what you achieved.

Respond with ONLY JSON:
{
  "goal": "what you're trying to achieve",
  "motivation": "why (1 sentence)",
  "steps": [
    { "action": "action_type", "target": "loc_id or npc_name or item", "description": "Concrete description of what you do and why" }
  ]
}`

  try {
    const parsed = await llmFunctionCall<{
      goal: string
      motivation: string
      steps: Array<{ action: string; target: string; description: string }>
    }>(
      'simulation',
      [{ role: 'system', content: prompt }, { role: 'user', content: 'Create a plan.' }],
      PLAN_SCHEMA
    )

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
    npc.activePlan.status = 'completed'
    return { executed: false, description: 'Plan completed' }
  }

  // Immobilized NPCs can only execute social/talk steps, not travel/search/physical
  const { IMMOBILIZING_TAGS: IMM_TAGS } = await import('../../shared/constants.js')
  const npcIsImmobilized = (npc.stateFlags ?? []).some((f) => IMM_TAGS.has(f))
  if (npcIsImmobilized) {
    const isSocialStep = ['talk', 'ask', 'tell', 'confront', 'persuade', 'beg', 'plead', 'shout', 'call', 'negotiate', 'charm', 'convince'].some((w) => currentStep.description.toLowerCase().includes(w))
    if (!isSocialStep) {
      // Skip non-social steps — fail them since NPC can't physically act
      currentStep.status = 'failed'
      currentStep.result = 'Cannot act — immobilized'
      updateNpcPlan(npc.id, npc.activePlan)
      return { executed: false, description: `${npc.name} can't do this while immobilized` }
    }
  }

  // Stale timeout — any step active for 5+ ticks auto-fails
  const stepAge = world.currentTick - (npc.activePlan.formedAtTick ?? 0)
  if (stepAge > 5 && currentStep.status === 'active') {
    const attemptMatch = currentStep.result?.match(/attempt (\d+)/)
    if (attemptMatch && parseInt(attemptMatch[1], 10) >= 3) {
      currentStep.status = 'failed'
      currentStep.result = 'Timed out after multiple attempts'
      updateNpcPlan(npc.id, npc.activePlan)
      return { executed: false, description: `${npc.name} gives up on: ${currentStep.description.slice(0, 40)}` }
    }
  }

  let result: { executed: boolean; description: string }

  // Reality check: if step targets an NPC who doesn't exist at the expected location, skip
  if (currentStep.action !== 'travel' && currentStep.action !== 'search' && currentStep.action !== 'observe') {
    const descLower = currentStep.description.toLowerCase()
    const tLower = currentStep.target.toLowerCase()

    // Check if step explicitly targets a specific NPC by name
    const targetedNpc = world.npcs.find((n) => {
      if (n.id === npc.id) return false
      const firstName = n.name.split(' ')[0].toLowerCase()
      return firstName.length >= 3 && (tLower.includes(firstName) || descLower.includes(firstName))
    })
    if (targetedNpc) {
      const targetNpcsHere = [targetedNpc].filter((n) => n.currentLocationId === npc.currentLocationId)

      // Nobody matching the description is here — auto-travel to find them
      if (targetNpcsHere.length === 0) {
        if (targetedNpc.currentLocationId !== npc.currentLocationId) {
          const fromLoc = npc.currentLocationId
          moveNpc(npc.id, targetedNpc.currentLocationId)
          broadcastEvent({
            type: 'npc_moved',
            data: { npcId: npc.id, fromLocationId: fromLoc, toLocationId: targetedNpc.currentLocationId },
          })
          currentStep.result = `Traveling to find ${targetedNpc.name}`
          return { executed: true, description: `${npc.name} goes to find ${targetedNpc.name}` }
        }
        // Same location but somehow not found — shouldn't happen, fail gracefully
        currentStep.status = 'failed'
        currentStep.result = 'Target not reachable'
        updateNpcPlan(npc.id, npc.activePlan)
        return { executed: false, description: `${npc.name} can't reach ${targetedNpc.name}` }
      }
    }
  }

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
    default: {
      // UNIVERSAL HANDLER: route ALL other actions through Game Master
      
      const descLower = currentStep.description.toLowerCase()
      const targetLower = currentStep.target.toLowerCase()

      // Check if step mentions a LOCATION the NPC isn't at — auto-travel there
      const mentionedLocation = world.locations.find((l) => {
        if (l.id === npc.currentLocationId) return false
        const locNameLower = l.name.toLowerCase()
        return targetLower.includes(locNameLower) || descLower.includes(locNameLower) ||
          l.id === currentStep.target
      })
      if (mentionedLocation) {
        const fromLoc = npc.currentLocationId
        moveNpc(npc.id, mentionedLocation.id)
        broadcastEvent({
          type: 'npc_moved',
          data: { npcId: npc.id, fromLocationId: fromLoc, toLocationId: mentionedLocation.id },
        })
        result = { executed: true, description: `${npc.name} heads to ${mentionedLocation.name}` }
        // Don't complete — actual action executes next tick at the new location
        break
      }

      // Check if targeting an NPC — ensure at same location
      const targetNpcForStep = world.npcs.find((n) => {
        if (n.id === npc.id) return false
        const nameLower = n.name.toLowerCase()
        const firstName = nameLower.split(' ')[0]
        return (
          n.id === currentStep.target ||
          nameLower.includes(targetLower) ||
          targetLower.includes(nameLower) ||
          targetLower.includes(firstName) ||
          descLower.includes(nameLower) ||
          descLower.includes(firstName)
        )
      })

      // Auto-travel to target NPC's location if not there
      if (targetNpcForStep && targetNpcForStep.currentLocationId !== npc.currentLocationId) {
        const fromLoc = npc.currentLocationId
        moveNpc(npc.id, targetNpcForStep.currentLocationId)
        broadcastEvent({
          type: 'npc_moved',
          data: { npcId: npc.id, fromLocationId: fromLoc, toLocationId: targetNpcForStep.currentLocationId },
        })
        result = { executed: true, description: `${npc.name} goes to find ${targetNpcForStep.name}` }
        // Don't complete the step yet — next tick will execute the actual action
        break
      }

      // Check if this is a VIOLENT action that should go through the GM, not conversation
      const isViolentAction = ['attack', 'fight', 'kill', 'stab', 'slash', 'punch', 'ambush',
        'knock', 'shoot', 'strike', 'hit', 'tackle', 'assassinate', 'murder', 'execute']
        .some((a) => currentStep.action.toLowerCase().includes(a) || descLower.includes(a))

      // If violent, skip conversation and route directly through Game Master
      if (isViolentAction && targetNpcForStep && targetNpcForStep.currentLocationId === npc.currentLocationId) {
        result = await executeAttempt(npc, currentStep, world)
        break
      }

      // If targeting a co-located NPC with a social action, trigger a REAL conversation
      const isSocialAction = ['confront', 'recruit', 'talk', 'approach', 'ask', 'tell',
        'persuade', 'charm', 'seduce', 'intimidate', 'negotiate', 'share_info', 'bribe']
        .some((a) => currentStep.action.toLowerCase().includes(a) || descLower.includes(a))

      if (targetNpcForStep && targetNpcForStep.currentLocationId === npc.currentLocationId && isSocialAction) {
        // Re-read the fresh plan from state — the conversation system may have already completed this step
        const freshNpc = getNpc(npc.id)
        const freshStep = freshNpc?.activePlan?.steps.find((s) => s.description === currentStep.description)
        if (freshStep && freshStep.status === 'completed') {
          currentStep.status = 'completed'
          currentStep.result = freshStep.result ?? 'Completed via conversation'
          result = { executed: true, description: `${npc.name} talked with ${targetNpcForStep.name}` }
          break
        }

        // Check if a conversation with the target already happened recently
        const targetFirstName = targetNpcForStep.name.split(' ')[0].toLowerCase()
        const recentConvoWithTarget = (freshNpc ?? npc).knowledge.some((k) =>
          k.turnLearned >= world.currentTick - 3 &&
          k.source.includes('conversation') &&
          k.source.toLowerCase().includes(targetFirstName)
        )
        if (recentConvoWithTarget) {
          // Check if this action should produce real world-state consequences (not just conversation)
          const isPhysicalAction = [
            // Combat/force
            'arrest', 'attack', 'fight', 'restrain', 'steal', 'sabotage', 'poison', 'ambush', 'knock out', 'tie up', 'punch', 'shove', 'lock up',
            // Social with physical consequences
            'seduce', 'undress', 'dress', 'strip', 'disguise', 'heal', 'bandage', 'feed', 'drug', 'intoxicate',
            // World manipulation
            'break', 'destroy', 'barricade', 'hide', 'plant', 'set fire', 'unlock', 'lock', 'repair', 'build', 'forge',
            // Item actions
            'give', 'hand over', 'drop', 'place', 'swap', 'trade',
          ].some((a) => descLower.includes(a))
          if (isPhysicalAction && targetNpcForStep) {
            // Route through Game Master for real physical consequences
            result = await executeAttempt(npc, currentStep, world)
          } else {
            const convoK = (freshNpc ?? npc).knowledge.find((k) =>
              k.turnLearned >= world.currentTick - 3 &&
              k.source.includes('conversation') &&
              k.source.toLowerCase().includes(targetFirstName)
            )
            currentStep.status = 'completed'
            currentStep.result = `Conversation happened: ${convoK?.content?.slice(0, 50) ?? 'discussed the matter'}`
            result = { executed: true, description: `${npc.name} talked with ${targetNpcForStep.name}` }
          }
          break
        }

        // Check if we've been trying this for too long (max 2 attempts)
        const attempts = (currentStep.result?.match(/attempt (\d+)/)?.[1] ?? '0')
        const attemptCount = parseInt(attempts, 10)

        if (attemptCount >= 2) {
          // Give up after 2 tries — complete with partial result
          currentStep.status = 'completed'
          currentStep.result = `Tried to talk to ${targetNpcForStep.name} but could not reach agreement`
          result = { executed: true, description: `${npc.name} gives up trying to convince ${targetNpcForStep.name}` }
          break
        }

        // Only add knowledge on first attempt to avoid flooding
        if (attemptCount === 0) {
          addNpcKnowledge(npc.id, [{
            id: uuid(),
            content: `I need to talk to ${targetNpcForStep.name} about: ${currentStep.description}. Part of my plan: ${npc.activePlan?.goal ?? 'unknown'}.`,
            source: 'self — plan execution',
            confidence: 1.0,
            importance: 1.0,
            turnLearned: world.currentTick,
            isSecret: true,
          }])
        }

        currentStep.result = `attempt ${attemptCount + 1} — waiting for conversation`
        result = { executed: true, description: `${npc.name} is ready to approach ${targetNpcForStep.name}` }
        broadcastEvent({
          type: 'npc_action',
          data: { npcId: npc.id, description: `${npc.name} prepares to approach ${targetNpcForStep.name}` },
        })
        break
      }

      result = await executeAttempt(npc, currentStep, world)
    }
      break
  }

  // Check if completed step fulfills an active agreement (keyword overlap)
  if (currentStep.status === 'completed' && currentStep.result) {
    const stepWords = new Set(
      `${currentStep.description} ${currentStep.result}`.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
    )
    for (const agr of (npc.agreements ?? []).filter((a) => a.active)) {
      const agrWords = agr.content.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
      const overlap = agrWords.filter((w) => stepWords.has(w)).length
      if (overlap >= 3 || (agrWords.length > 0 && overlap / agrWords.length > 0.4)) {
        completeAgreement(npc.id, agr.content)
        console.log(`[Agreement Completed] ${npc.name}: "${agr.content.slice(0, 50)}"`)
      }
    }
  }

  // Advance to next step on completion OR failure
  if (currentStep.status === 'completed' || currentStep.status === 'failed') {
    // Check if too many steps have failed — abandon plan and replan
    const failedCount = npc.activePlan.steps.filter((s) => s.status === 'failed').length
    if (failedCount >= 3) {
      npc.activePlan.status = 'abandoned'
      addNpcKnowledge(npc.id, [{
        id: uuid(),
        content: `My plan "${npc.activePlan.goal}" has mostly failed. I need a completely new approach.`,
        source: 'self — plan abandoned',
        confidence: 1.0,
        importance: 0.8,
        turnLearned: world.currentTick,
        isSecret: false,
      }])
      broadcastEvent({
        type: 'npc_plan',
        data: { npcId: npc.id, goal: npc.activePlan.goal, status: 'abandoned', stepCount: npc.activePlan.steps.length },
      })
    } else {
      const nextPending = npc.activePlan.steps.find((s) => s.status === 'pending')
      if (nextPending) {
        nextPending.status = 'active'
      } else if (npc.activePlan.steps.every((s) => s.status === 'completed' || s.status === 'failed' || s.status === 'skipped')) {
        npc.activePlan.status = 'completed'
        broadcastEvent({
          type: 'npc_plan',
          data: { npcId: npc.id, goal: npc.activePlan.goal, status: 'completed', stepCount: npc.activePlan.steps.length },
        })
      }
    }
  }

  // Persist plan state changes through proper state management
  updateNpcPlan(npc.id, npc.activePlan)

  return result
}

function executeTravel(npc: NPC, step: PlanStep, world: WorldState): { executed: boolean; description: string } {
  const targetLower = step.target.toLowerCase()
  const descLower = step.description.toLowerCase()

  // Match location by: ID, name in target, name in description, or target in name
  const targetLoc = world.locations.find((l) => {
    const locLower = l.name.toLowerCase()
    return l.id === step.target ||
      locLower === targetLower ||
      targetLower.includes(locLower) ||
      descLower.includes(locLower) ||
      locLower.includes(targetLower)
  })

  if (!targetLoc) {
    step.status = 'failed'
    step.result = `Location not found in: "${step.target.slice(0, 40)}"`
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

  step.status = 'completed'
  step.result = 'Searched but found nothing useful'
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
      tags: [...npc.occupationTags, ...(npc.stateFlags ?? [])],
      health: npc.physical.health,
      injuries: npc.physical.injuries,
    },
    action: step.description,
    target: {
      name: targetNpc?.name ?? step.target,
      tags: [...(targetNpc?.occupationTags ?? []), ...(targetNpc?.stateFlags ?? [])],
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
      // Apply GM-determined tags
      if (gmResult.effects.targetTagChanges?.length > 0) {
        updateNpcStateFlags(targetNpc.id, gmResult.effects.targetTagChanges)
      }
      if (gmResult.effects.actorTagChanges?.length > 0) {
        updateNpcStateFlags(npc.id, gmResult.effects.actorTagChanges)
      }
      // Fallback: any damage = injured tag
      if (gmResult.effects.targetHealthDelta < 0 && !(gmResult.effects.targetTagChanges ?? []).some((t: string) => t.includes('injured'))) {
        updateNpcStateFlags(targetNpc.id, ['add:injured'])
      }
      if (gmResult.effects.relationshipImpact !== 0) {
        updateNpcRelationship(npc.id, targetNpc.id, {
          affection: gmResult.effects.relationshipImpact,
          trust: gmResult.effects.relationshipImpact,
        })
      }

      // Target NPC becomes aware of what happened
      addNpcKnowledge(targetNpc.id, [{
        id: uuid(),
        content: `${npc.name} ${result.outcome === 'failure' ? 'attempted something but failed' : 'did something successfully'}: ${result.narrativeHint}`,
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
      content: `Attempted but failed: ${result.narrativeHint}`,
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
    content: result.narrativeHint,
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

  // Persist physical effects immediately
  await persistGame()

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

  // Immobilized NPCs can still plan and talk, but can't physically move or execute non-social steps
  const { IMMOBILIZING_TAGS } = await import('../../shared/constants.js')
  const isImmobilized = (npc.stateFlags ?? []).some((f) => IMMOBILIZING_TAGS.has(f))

  // Clear completed/abandoned plans so NPCs can form new ones
  if (npc.activePlan?.status === 'completed' || npc.activePlan?.status === 'abandoned') {
    updateNpcPlan(npc.id, null)
  }

  // Check for significant events that should interrupt the current plan
  if (npc.activePlan?.status === 'active') {
    const criticalEvents = npc.knowledge.filter((k) =>
      k.turnLearned === world.currentTick &&
      k.importance >= 0.8 &&
      (k.source === 'experienced' || k.source === 'witnessed')
    )
    if (criticalEvents.length > 0) {
      console.log(`[Interrupt] ${npc.name} interrupted by: ${criticalEvents[0].content.slice(0, 50)}`)
      updateNpcPlan(npc.id, null)
      // Fall through to activation system to form new plan this tick
    }
  }

  // Execute active plans
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
  // No active plan — check if we should form one
  const activation = calculateActivation(npc, world)

  if (activation < ACTIVATION_THRESHOLD_LOW) {
    return { action: 'routine', llmCalls: 0 }
  }

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

  return { action: 'thinking', llmCalls: 0 }
}
