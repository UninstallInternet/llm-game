import { v4 as uuid } from 'uuid'
import {
  getWorld,
  getPlayer,
  addNpcKnowledge,
  updateNpcRelationship,
  updateNpcMoodGeneral,
  addNpcAgreement,
  transferItem,
  updateNpcPlan,
  isNpcBusy,
  markNpcBusy,
  markNpcFree,
} from '../game/state.js'
import { llmCall } from '../llm/client.js'
import { buildGroupConversationPrompt } from '../llm/prompts.js'
import { broadcastEvent } from '../routes/events.js'
import {
  MAX_NPC_CONVERSATIONS_PER_TICK,
  MIN_CONVERSATION_SCORE,
  MAX_GROUP_SIZE,
} from '../../shared/constants.js'
import type { NPC, WorldState, NpcConversationResult } from '../../shared/types.js'

// ─── Active Ongoing Conversations ───

interface OngoingConversation {
  participantIds: string[]
  playerJoined: boolean
  locationId: string
  startedAtTick: number
  history: Array<{ speaker: string; says: string }>
  roundsRemaining: number
  topic: string
}

const activeConversations: OngoingConversation[] = []

const MAX_CONVERSATION_ROUNDS = 4

export function getActiveConversationAtLocation(locationId: string): OngoingConversation | undefined {
  return activeConversations.find((c) => c.locationId === locationId)
}

export function injectPlayerMessage(locationId: string, message: string): boolean {
  const conv = activeConversations.find((c) => c.locationId === locationId)
  if (!conv) return false
  conv.playerJoined = true
  conv.history.push({ speaker: 'Visitor', says: message })
  return true
}

// ─── Group Selection ───

function scorePair(a: NPC, b: NPC, world: WorldState): number {
  let score = 0
  const relAtoB = a.relationships.find((r) => r.targetNpcId === b.id)
  const relBtoA = b.relationships.find((r) => r.targetNpcId === a.id)
  const intensityA = relAtoB
    ? (Math.abs(relAtoB.trust) + Math.abs(relAtoB.affection) + Math.abs(relAtoB.respect) + relAtoB.fear) / 400
    : 0
  const intensityB = relBtoA
    ? (Math.abs(relBtoA.trust) + Math.abs(relBtoA.affection) + Math.abs(relBtoA.respect) + relBtoA.fear) / 400
    : 0
  score += ((intensityA + intensityB) / 2) * 0.25

  const aTopics = new Set(a.knowledge.filter((k) => !k.isSecret).map((k) => k.content))
  const bTopics = new Set(b.knowledge.filter((k) => !k.isSecret).map((k) => k.content))
  const unique = [...aTopics].filter((t) => !bTopics.has(t)).length +
    [...bTopics].filter((t) => !aTopics.has(t)).length
  score += Math.min(unique / 10, 0.25)

  if (a.factionId && b.factionId && a.factionId !== b.factionId) score += 0.15
  if (relAtoB?.type === 'rival' || relAtoB?.type === 'enemy') score += 0.1
  score += Math.random() * 0.05

  const recentlySpoke = a.knowledge.some(
    (k) => k.source.includes(b.name) && k.turnLearned >= world.currentTick - 4
  ) || b.knowledge.some(
    (k) => k.source.includes(a.name) && k.turnLearned >= world.currentTick - 4
  )
  if (recentlySpoke) score *= 0.05

  return score
}

function selectConversationGroups(world: WorldState): NPC[][] {
  const byLocation = new Map<string, NPC[]>()
  for (const npc of world.npcs) {
    if (npc.physical?.status !== 'alive') continue
    const group = byLocation.get(npc.currentLocationId) ?? []
    group.push(npc)
    byLocation.set(npc.currentLocationId, group)
  }

  const selected: NPC[][] = []
  const usedIds = new Set<string>()

  // Skip NPCs in ongoing conversations
  for (const conv of activeConversations) {
    for (const id of conv.participantIds) usedIds.add(id)
  }

  // PRIORITY 1: Plan-driven groups (NPC targeting another + shared context)
  for (const npc of world.npcs) {
    if (isNpcBusy(npc.id) || usedIds.has(npc.id)) continue
    if (!npc.activePlan || npc.activePlan.status !== 'active') continue

    const activeStep = npc.activePlan.steps.find((s) => s.status === 'active')
    if (!activeStep) continue

    const descLower = activeStep.description.toLowerCase()
    const tLower = activeStep.target.toLowerCase()

    // Find target NPC
    const targets = world.npcs.filter((n) => {
      if (n.id === npc.id || isNpcBusy(n.id) || usedIds.has(n.id)) return false
      if (n.currentLocationId !== npc.currentLocationId) return false
      const nameLower = n.name.toLowerCase()
      const firstName = nameLower.split(' ')[0]
      return n.id === activeStep.target || tLower.includes(firstName) || descLower.includes(firstName)
    })

    if (targets.length > 0) {
      // Check if other NPCs at the same location have related plans/agreements
      const locationNpcs = (byLocation.get(npc.currentLocationId) ?? [])
        .filter((n) => !usedIds.has(n.id) && !isNpcBusy(n.id) && n.id !== npc.id && !targets.some((t) => t.id === n.id))

      const relatedNpcs = locationNpcs.filter((n) => {
        // Has agreement with any of the core participants?
        const hasAgreement = (n.agreements ?? []).some((a) =>
          a.active && (a.withId === npc.id || targets.some((t) => a.withId === t.id))
        )
        // Has plan related to the topic?
        const hasPlan = n.activePlan?.goal?.toLowerCase().includes(activeStep.target.toLowerCase().split(' ')[0]) ?? false
        return hasAgreement || hasPlan
      })

      const group = [npc, ...targets.slice(0, 2), ...relatedNpcs.slice(0, MAX_GROUP_SIZE - 2 - targets.length)]
        .slice(0, MAX_GROUP_SIZE)

      if (group.length >= 2 && selected.length < MAX_NPC_CONVERSATIONS_PER_TICK) {
        selected.push(group)
        for (const n of group) usedIds.add(n.id)
      }
    }
  }

  // PRIORITY 2: Score-based pairs (existing logic)
  for (const [_locId, npcs] of byLocation) {
    const available = npcs.filter((n) => !isNpcBusy(n.id) && !usedIds.has(n.id))
    if (available.length < 2) continue

    let bestPair: [NPC, NPC] | null = null
    let bestScore = MIN_CONVERSATION_SCORE

    for (let i = 0; i < available.length; i++) {
      for (let j = i + 1; j < available.length; j++) {
        const score = scorePair(available[i], available[j], world)
        if (score > bestScore) {
          bestScore = score
          bestPair = [available[i], available[j]]
        }
      }
    }

    if (bestPair && selected.length < MAX_NPC_CONVERSATIONS_PER_TICK) {
      selected.push(bestPair)
      usedIds.add(bestPair[0].id)
      usedIds.add(bestPair[1].id)
    }
  }

  return selected
}

// ─── LLM Call + Parse ───

interface RawGroupResponse {
  dialogue?: Array<{ speaker: string; says: string }>
  summary: string
  concluded: boolean
  outcome?: {
    agreement_reached?: string | null
    item_transferred?: { from: string; to: string; item: string } | null
    conflict?: string | null
  }
  takeaways: Record<string, {
    knowledge: string
    mood_shift: string | null
    relationship_deltas: Record<string, number>
    internal_reaction: string
  }>
}

function parseGroupResponse(raw: string): RawGroupResponse {
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  }
  return JSON.parse(cleaned) as RawGroupResponse
}

async function runGroupConversationRound(
  participants: NPC[],
  world: WorldState,
  priorDialogue: Array<{ speaker: string; says: string }>,
  playerJoined: boolean
): Promise<RawGroupResponse | null> {
  try {
    const { system, user: baseUser } = buildGroupConversationPrompt(participants, world, playerJoined)

    const historyStr = priorDialogue.length > 0
      ? `\n\nCONVERSATION SO FAR (continue — do NOT repeat):\n${priorDialogue.map((d) => `${d.speaker}: ${d.says}`).join('\n')}\n\nContinue with 3-5 NEW exchanges. Deepen the discussion. Only set concluded=true if a clear resolution is reached.`
      : ''

    const fullUser = baseUser + historyStr
    const rawResponse = await llmCall('simulation', system, fullUser, true)
    return parseGroupResponse(rawResponse)
  } catch (error) {
    console.error(`Group conversation failed:`, error)
    return null
  }
}

// ─── Apply Results ───

function applyGroupResult(result: NpcConversationResult, world: WorldState): void {
  for (const npcId of result.participantIds) {
    const npc = world.npcs.find((n) => n.id === npcId)
    if (!npc) continue

    const takeaway = result.takeaways[npcId] ?? result.takeaways[npc.name]
    if (!takeaway) continue

    const otherNames = result.participantIds
      .filter((id) => id !== npcId)
      .map((id) => world.npcs.find((n) => n.id === id)?.name ?? id)
      .join(', ')

    if (takeaway.knowledge) {
      addNpcKnowledge(npcId, [{
        id: uuid(),
        content: takeaway.knowledge,
        source: `group conversation with ${otherNames}`,
        confidence: 0.8,
        importance: 0.7,
        turnLearned: result.tick,
        isSecret: false,
      }])
    }

    if (takeaway.moodShift) {
      updateNpcMoodGeneral(npcId, takeaway.moodShift, `after group conversation`)
    }

    // Apply relationship deltas to each other participant
    for (const [otherId, delta] of Object.entries(takeaway.relationshipDeltas ?? {})) {
      if (delta !== 0) {
        const actualId = world.npcs.find((n) => n.id === otherId || n.name === otherId)?.id
        if (actualId) {
          updateNpcRelationship(npcId, actualId, { trust: delta, affection: Math.round(delta * 0.5) })
        }
      }
    }

    // Mark related plan steps as completed — immutably
    if (npc.activePlan?.status === 'active' && result.outcome) {
      const newSteps = npc.activePlan.steps.map((step) => {
        if (step.status !== 'active') return step
        const matchesParticipant = result.participantIds.some((pid) => {
          const pnpc = world.npcs.find((n) => n.id === pid)
          if (!pnpc || pnpc.id === npcId) return false
          const firstName = pnpc.name.split(' ')[0].toLowerCase()
          return step.target.toLowerCase().includes(firstName) || step.description.toLowerCase().includes(firstName)
        })
        if (matchesParticipant) {
          return { ...step, status: 'completed' as const, result: `Group conversation: ${result.summary.slice(0, 60)}` }
        }
        return step
      })
      // Advance to next pending step
      const hasActive = newSteps.some((s) => s.status === 'active')
      const finalSteps = hasActive ? newSteps : newSteps.map((s, i) => {
        if (s.status === 'pending' && !newSteps.slice(0, i).some((prev) => prev.status === 'pending')) {
          return { ...s, status: 'active' as const }
        }
        return s
      })
      const allDone = finalSteps.every((s) => s.status !== 'pending' && s.status !== 'active')
      updateNpcPlan(npcId, {
        ...npc.activePlan,
        steps: finalSteps,
        status: allDone ? 'completed' : npc.activePlan.status,
      })
    }
  }

  // Apply outcomes
  if (result.outcome) {
    if (result.outcome.agreement_reached) {
      // All participants get the agreement with each other
      for (let i = 0; i < result.participantIds.length; i++) {
        for (let j = i + 1; j < result.participantIds.length; j++) {
          addNpcAgreement(result.participantIds[i], result.participantIds[j], result.outcome.agreement_reached, result.tick)
          addNpcAgreement(result.participantIds[j], result.participantIds[i], result.outcome.agreement_reached, result.tick)
        }
      }
    }

    if (result.outcome.item_transferred) {
      const { from, to, item } = result.outcome.item_transferred
      const fromNpc = world.npcs.find((n) => n.name.toLowerCase().includes(from.toLowerCase()) || from.toLowerCase().includes(n.name.split(' ')[0].toLowerCase()))
      const toNpc = world.npcs.find((n) => n.name.toLowerCase().includes(to.toLowerCase()) || to.toLowerCase().includes(n.name.split(' ')[0].toLowerCase()))
      if (fromNpc && toNpc) transferItem(fromNpc.id, toNpc.id, item)
    }
  }
}

// ─── Public Entry Point ───

export async function runNpcConversations(): Promise<NpcConversationResult[]> {
  const world = getWorld()
  const results: NpcConversationResult[] = []

  // 1. Continue ongoing conversations
  for (let i = activeConversations.length - 1; i >= 0; i--) {
    const conv = activeConversations[i]
    const participants = conv.participantIds.map((id) => world.npcs.find((n) => n.id === id)).filter(Boolean) as NPC[]

    if (participants.length < 2) {
      for (const id of conv.participantIds) markNpcFree(id)
      activeConversations.splice(i, 1)
      continue
    }

    // Check they're all still at the same location
    const allSameLocation = participants.every((p) => p.currentLocationId === conv.locationId)
    if (!allSameLocation) {
      for (const id of conv.participantIds) markNpcFree(id)
      activeConversations.splice(i, 1)
      continue
    }

    for (const p of participants) markNpcBusy(p.id)

    const parsed = await runGroupConversationRound(participants, world, conv.history, conv.playerJoined)

    if (parsed) {
      for (const d of parsed.dialogue ?? []) conv.history.push(d)

      const names = participants.map((p) => p.name).join(', ')
      const roundSummary = (parsed.dialogue ?? []).map((d) => `${d.speaker}: ${d.says.slice(0, 60)}`).join(' | ')
      broadcastEvent({
        type: 'npc_conversation',
        data: {
          participantIds: conv.participantIds,
          locationId: conv.locationId,
          summary: roundSummary || parsed.summary,
          thoughts: Object.fromEntries(
            Object.entries(parsed.takeaways ?? {}).map(([k, v]) => [k, v.internal_reaction ?? ''])
          ),
        },
      })

      conv.roundsRemaining--

      if (parsed.concluded || conv.roundsRemaining <= 0) {
        const result: NpcConversationResult = {
          participantIds: conv.participantIds,
          locationId: conv.locationId,
          tick: world.currentTick,
          summary: parsed.summary || `${names} finished their conversation.`,
          dialogue: conv.history,
          takeaways: Object.fromEntries(
            Object.entries(parsed.takeaways ?? {}).map(([key, val]) => [
              // Map NPC names to IDs
              participants.find((p) => p.name === key)?.id ?? key,
              {
                knowledge: val.knowledge ?? '',
                moodShift: val.mood_shift ?? null,
                relationshipDeltas: val.relationship_deltas ?? {},
                internalReaction: val.internal_reaction ?? '',
              },
            ])
          ),
          outcome: parsed.outcome ?? null,
        }
        applyGroupResult(result, world)
        results.push(result)
        console.log(`[Group Chat Done] ${names} (${conv.history.length} lines): ${result.summary.slice(0, 80)}`)

        for (const id of conv.participantIds) markNpcFree(id)
        activeConversations.splice(i, 1)
      }
    } else {
      for (const id of conv.participantIds) markNpcFree(id)
      activeConversations.splice(i, 1)
    }
  }

  // 2. Start new conversations/groups
  const groups = selectConversationGroups(world)
  for (const group of groups) {
    for (const npc of group) markNpcBusy(npc.id)

    const topic = group[0].activePlan?.status === 'active' ? group[0].activePlan.goal : 'general interaction'
    const parsed = await runGroupConversationRound(group, world, [], false)

    if (!parsed) {
      for (const npc of group) markNpcFree(npc.id)
      continue
    }

    const dialogueHistory = parsed.dialogue ?? []
    const names = group.map((n) => n.name).join(', ')
    const roundSummary = dialogueHistory.map((d) => `${d.speaker}: ${d.says.slice(0, 60)}`).join(' | ')

    broadcastEvent({
      type: 'npc_conversation',
      data: {
        participantIds: group.map((n) => n.id),
        locationId: group[0].currentLocationId,
        summary: roundSummary || parsed.summary,
        thoughts: Object.fromEntries(
          Object.entries(parsed.takeaways ?? {}).map(([k, v]) => [k, v.internal_reaction ?? ''])
        ),
      },
    })

    if (parsed.concluded) {
      const participantIds = group.map((n) => n.id)
      const result: NpcConversationResult = {
        participantIds,
        locationId: group[0].currentLocationId,
        tick: world.currentTick,
        summary: parsed.summary,
        dialogue: dialogueHistory,
        takeaways: Object.fromEntries(
          Object.entries(parsed.takeaways ?? {}).map(([key, val]) => [
            group.find((p) => p.name === key)?.id ?? key,
            {
              knowledge: val.knowledge ?? '',
              moodShift: val.mood_shift ?? null,
              relationshipDeltas: val.relationship_deltas ?? {},
              internalReaction: val.internal_reaction ?? '',
            },
          ])
        ),
        outcome: parsed.outcome ?? null,
      }
      applyGroupResult(result, world)
      results.push(result)
      console.log(`[Group Chat] ${names}: ${result.summary.slice(0, 80)}`)
      for (const npc of group) markNpcFree(npc.id)
    } else {
      activeConversations.push({
        participantIds: group.map((n) => n.id),
        playerJoined: false,
        locationId: group[0].currentLocationId,
        startedAtTick: world.currentTick,
        history: dialogueHistory,
        roundsRemaining: MAX_CONVERSATION_ROUNDS - 1,
        topic,
      })
      console.log(`[Group Chat Started] ${names}: "${topic}" (${MAX_CONVERSATION_ROUNDS} rounds max)`)
    }
  }

  return results
}
