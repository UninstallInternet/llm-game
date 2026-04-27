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
import { llmFunctionCall } from '../llm/client.js'
import { GROUP_CONVERSATION_SCHEMA } from '../llm/schemas.js'
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

// ─── Need-Driven Conversation Selection ───
// NPCs only talk when they have a REASON. No reason = no conversation.

interface ConversationReason {
  participants: NPC[]
  reason: string  // injected into the conversation prompt
  priority: number
}

function findConversationReasons(world: WorldState): ConversationReason[] {
  const reasons: ConversationReason[] = []
  const checked = new Set<string>() // avoid duplicate pairs

  for (const npc of world.npcs) {
    if (npc.physical?.status !== 'alive' || isNpcBusy(npc.id)) continue

    const coLocated = world.npcs.filter((n) =>
      n.id !== npc.id && n.currentLocationId === npc.currentLocationId &&
      n.physical?.status === 'alive' && !isNpcBusy(n.id)
    )

    for (const other of coLocated) {
      const pairKey = [npc.id, other.id].sort().join('|')
      if (checked.has(pairKey)) continue
      checked.add(pairKey)

      // Check cooldown — talked in last 12 ticks? Skip unless plan-driven.
      const recentlySpoke = npc.knowledge.some(
        (k) => k.source.includes(other.name) && k.source.includes('conversation') && k.turnLearned >= world.currentTick - 12
      )

      // REASON 1: Plan step targets this NPC (active OR pending — they intend to interact)
      const npcTargetsOther = npc.activePlan?.status === 'active' && npc.activePlan.steps.some((s) => {
        if (s.status !== 'active' && s.status !== 'pending') return false
        const firstName = other.name.split(' ')[0].toLowerCase()
        return s.target.toLowerCase().includes(firstName) || s.description.toLowerCase().includes(firstName)
      })
      const otherTargetsNpc = other.activePlan?.status === 'active' && other.activePlan.steps.some((s) => {
        if (s.status !== 'active' && s.status !== 'pending') return false
        const firstName = npc.name.split(' ')[0].toLowerCase()
        return s.target.toLowerCase().includes(firstName) || s.description.toLowerCase().includes(firstName)
      })

      if (npcTargetsOther || otherTargetsNpc) {
        const initiator = npcTargetsOther ? npc : other
        const step = initiator.activePlan!.steps.find((s) => s.status === 'active')!
        reasons.push({
          participants: [npc, other],
          reason: `${initiator.name} needs to talk to ${initiator === npc ? other.name : npc.name} about: ${step.description}`,
          priority: 10,
        })
        continue
      }

      // Skip all other reasons if recently spoke
      if (recentlySpoke) continue

      // REASON 2: One has NEW information the other doesn't know
      const npcRecentKnowledge = npc.knowledge.filter(
        (k) => k.turnLearned >= world.currentTick - 6 && !k.isSecret && k.importance >= 0.5
      )
      const otherRecentKnowledge = other.knowledge.filter(
        (k) => k.turnLearned >= world.currentTick - 6 && !k.isSecret && k.importance >= 0.5
      )
      const npcHasNews = npcRecentKnowledge.some((k) =>
        !other.knowledge.some((ok) => ok.content.slice(0, 30) === k.content.slice(0, 30))
      )
      const otherHasNews = otherRecentKnowledge.some((k) =>
        !npc.knowledge.some((nk) => nk.content.slice(0, 30) === k.content.slice(0, 30))
      )

      if (npcHasNews || otherHasNews) {
        reasons.push({
          participants: [npc, other],
          reason: `${npcHasNews ? npc.name : other.name} has new information to share`,
          priority: 5,
        })
        continue
      }

      // REASON 3: Active event involves both
      const sharedEvent = world.events.find((e) =>
        !e.resolved && e.triggerDay <= world.time.day &&
        e.involvedNpcIds.includes(npc.id) && e.involvedNpcIds.includes(other.id)
      )
      if (sharedEvent) {
        reasons.push({
          participants: [npc, other],
          reason: `Both are involved in: ${sharedEvent.title}`,
          priority: 4,
        })
        continue
      }

      // REASON 4: Never met before
      const neverMet = !npc.knowledge.some((k) => k.source.includes(other.name))
      if (neverMet) {
        reasons.push({
          participants: [npc, other],
          reason: `First meeting between ${npc.name} and ${other.name}`,
          priority: 3,
        })
        continue
      }

      // REASON 5: Both have active plans — they might need to coordinate or conflict
      if (npc.activePlan?.status === 'active' && other.activePlan?.status === 'active') {
        reasons.push({
          participants: [npc, other],
          reason: `Both are pursuing their own goals and may need to coordinate or may come into conflict. ${npc.name} is working on: ${npc.activePlan.goal.slice(0, 40)}. ${other.name} is working on: ${other.activePlan.goal.slice(0, 40)}.`,
          priority: 2,
        })
        continue
      }

      // REASON 6: Periodic social check-in (haven't talked in 20+ ticks)
      const lastTalked = Math.max(
        ...npc.knowledge.filter((k) => k.source.includes(other.name)).map((k) => k.turnLearned),
        0
      )
      if (world.currentTick - lastTalked > 20) {
        reasons.push({
          participants: [npc, other],
          reason: `It's been a while since ${npc.name} and ${other.name} talked. They should check in given the tense situation.`,
          priority: 1,
        })
        continue
      }
    }
  }

  return reasons.sort((a, b) => b.priority - a.priority)
}

function selectConversationGroups(world: WorldState): NPC[][] {
  const reasons = findConversationReasons(world)
  const selected: NPC[][] = []
  const usedIds = new Set<string>()

  // Skip NPCs in ongoing conversations
  for (const conv of activeConversations) {
    for (const id of conv.participantIds) usedIds.add(id)
  }

  for (const reason of reasons) {
    if (selected.length >= MAX_NPC_CONVERSATIONS_PER_TICK) break

    const available = reason.participants.filter((n) => !usedIds.has(n.id))
    if (available.length < 2) continue

    selected.push(available.slice(0, MAX_GROUP_SIZE))
    for (const n of available) usedIds.add(n.id)

    console.log(`[Convo Reason] ${available.map((n) => n.name).join(' + ')}: ${reason.reason}`)
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
    return await llmFunctionCall<RawGroupResponse>(
      'simulation',
      [{ role: 'system', content: system }, { role: 'user', content: fullUser }],
      GROUP_CONVERSATION_SCHEMA
    )
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

  // Single-round conversations — always produce results immediately
  const groups = selectConversationGroups(world)
  for (const group of groups) {
    for (const npc of group) markNpcBusy(npc.id)

    const parsed = await runGroupConversationRound(group, world, [], false)

    // Always free participants immediately
    for (const npc of group) markNpcFree(npc.id)

    if (!parsed) continue

    const dialogueHistory = parsed.dialogue ?? []
    const names = group.map((n) => n.name).join(', ')
    const roundSummary = dialogueHistory.map((d) => `${d.speaker}: ${d.says}`).join(' | ')

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

    // ALWAYS apply results immediately — no multi-round waiting
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
    console.log(`[Convo] ${names}: ${result.summary.slice(0, 80)}`)
  }

  return results
}
