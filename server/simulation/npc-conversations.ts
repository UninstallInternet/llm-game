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
  addScheduledMeeting,
  applyPhysicalEffects,
  updateNpcStateFlags,
} from '../game/state.js'
import { llmFunctionCall } from '../llm/client.js'
import { GROUP_CONVERSATION_SCHEMA } from '../llm/schemas.js'
import { buildGroupConversationPrompt } from '../llm/prompts.js'
import { broadcastEvent } from '../routes/events.js'
import {
  MAX_NPC_CONVERSATIONS_PER_TICK,
  MIN_CONVERSATION_SCORE,
  MAX_GROUP_SIZE,
  TAG_EFFECTS,
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
    if (npc.physical?.status === 'dead' || npc.physical?.status === 'unconscious' || isNpcBusy(npc.id)) continue

    const coLocated = world.npcs.filter((n) =>
      n.id !== npc.id && n.currentLocationId === npc.currentLocationId &&
      n.physical?.status !== 'dead' && n.physical?.status !== 'unconscious' && !isNpcBusy(n.id)
    )

    for (const other of coLocated) {
      const pairKey = [npc.id, other.id].sort().join('|')
      if (checked.has(pairKey)) continue
      checked.add(pairKey)

      // Check cooldown — talked in last 12 ticks? Skip unless plan-driven.
      const recentlySpoke = npc.knowledge.some(
        (k) => k.source.includes(other.name) && k.source.includes('conversation') && k.turnLearned >= world.currentTick - 12
      )

      // REASON 1: Plan step targets this NPC — active steps get higher priority than pending
      const npcActiveTargetsOther = npc.activePlan?.status === 'active' && npc.activePlan.steps.some((s) => {
        if (s.status !== 'active') return false
        const firstName = other.name.split(' ')[0].toLowerCase()
        return s.target.toLowerCase().includes(firstName) || s.description.toLowerCase().includes(firstName)
      })
      const otherActiveTargetsNpc = other.activePlan?.status === 'active' && other.activePlan.steps.some((s) => {
        if (s.status !== 'active') return false
        const firstName = npc.name.split(' ')[0].toLowerCase()
        return s.target.toLowerCase().includes(firstName) || s.description.toLowerCase().includes(firstName)
      })
      const npcPendingTargetsOther = !npcActiveTargetsOther && npc.activePlan?.status === 'active' && npc.activePlan.steps.some((s) => {
        if (s.status !== 'pending') return false
        const firstName = other.name.split(' ')[0].toLowerCase()
        return s.target.toLowerCase().includes(firstName) || s.description.toLowerCase().includes(firstName)
      })
      const otherPendingTargetsNpc = !otherActiveTargetsNpc && other.activePlan?.status === 'active' && other.activePlan.steps.some((s) => {
        if (s.status !== 'pending') return false
        const firstName = npc.name.split(' ')[0].toLowerCase()
        return s.target.toLowerCase().includes(firstName) || s.description.toLowerCase().includes(firstName)
      })

      if (npcActiveTargetsOther || otherActiveTargetsNpc) {
        const initiator = npcActiveTargetsOther ? npc : other
        const step = initiator.activePlan!.steps.find((s) => s.status === 'active')
        if (!step) continue
        // Boost priority if the step has been waiting (attempt 1+)
        const isWaiting = step.result?.includes('attempt') || step.result?.includes('Traveling to find')
        reasons.push({
          participants: [npc, other],
          reason: `${initiator.name} needs to talk to ${initiator === npc ? other.name : npc.name} about: ${step.description}`,
          priority: isWaiting ? 15 : 10, // Waiting steps get top priority
        })
        continue
      }
      // REASON 1.5: Scheduled meeting between these two NPCs
      const npcMeeting = (npc.scheduledMeetings ?? []).find(
        (m) => m.status === 'pending' && m.withId === other.id && Math.abs(m.tick - world.currentTick) <= 2
      )
      const otherMeeting = (other.scheduledMeetings ?? []).find(
        (m) => m.status === 'pending' && m.withId === npc.id && Math.abs(m.tick - world.currentTick) <= 2
      )
      if (npcMeeting || otherMeeting) {
        const meeting = npcMeeting ?? otherMeeting!
        reasons.push({
          participants: [npc, other],
          reason: `Scheduled meeting: ${meeting.purpose}`,
          priority: 9,
        })
        continue
      }

      if (npcPendingTargetsOther || otherPendingTargetsNpc) {
        const initiator = npcPendingTargetsOther ? npc : other
        const step = initiator.activePlan!.steps.find((s) => s.status === 'pending')
        if (!step) continue
        reasons.push({
          participants: [npc, other],
          reason: `${initiator.name} eventually intends to interact with ${initiator === npc ? other.name : npc.name} about: ${step.description}`,
          priority: 6, // Pending step — lower than active
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

      // REASON 3.5: One NPC has a visible state tag the other hasn't seen before
      // Any tag is visible unless explicitly hidden in TAG_EFFECTS
      const otherVisibleTags = (other.stateFlags ?? []).filter((f) => TAG_EFFECTS[f]?.visible !== false)
      const npcVisibleTags = (npc.stateFlags ?? []).filter((f) => TAG_EFFECTS[f]?.visible !== false)
      const unseenTag = otherVisibleTags.find((tag) =>
        !npc.knowledge.some((k) => k.content.toLowerCase().includes(tag) && k.content.includes(other.name.split(' ')[0]))
      ) || npcVisibleTags.find((tag) =>
        !other.knowledge.some((k) => k.content.toLowerCase().includes(tag) && k.content.includes(npc.name.split(' ')[0]))
      )
      if (unseenTag) {
        const observer = otherVisibleTags.includes(unseenTag) ? npc : other
        const observed = observer === npc ? other : npc
        reasons.push({
          participants: [npc, other],
          reason: `${observer.name} notices that ${observed.name} is ${unseenTag} (${TAG_EFFECTS[unseenTag]?.description ?? unseenTag})`,
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

interface SelectedGroup {
  participants: NPC[]
  reason: string
}

function selectConversationGroups(world: WorldState): SelectedGroup[] {
  const reasons = findConversationReasons(world)
  const selected: SelectedGroup[] = []
  const usedIds = new Set<string>()

  // Skip NPCs in ongoing conversations
  for (const conv of activeConversations) {
    for (const id of conv.participantIds) usedIds.add(id)
  }

  // Merge: if multiple high-priority reasons target the same NPC, combine into one group
  const targetCounts = new Map<string, { reasons: ConversationReason[]; target: NPC }>()
  for (const reason of reasons) {
    if (reason.priority < 10) break // only merge high-priority
    for (const p of reason.participants) {
      // Check if this NPC is targeted BY others (appears as participant in multiple reasons)
      const existing = targetCounts.get(p.id)
      if (existing) {
        existing.reasons.push(reason)
      } else {
        targetCounts.set(p.id, { reasons: [reason], target: p })
      }
    }
  }
  // If any NPC is targeted by 3+ reasons, create a merged group conversation
  for (const [, entry] of targetCounts) {
    if (entry.reasons.length >= 2 && !usedIds.has(entry.target.id)) {
      const allParticipants = new Set<string>()
      allParticipants.add(entry.target.id)
      for (const r of entry.reasons) {
        for (const p of r.participants) allParticipants.add(p.id)
      }
      const participants = [...allParticipants]
        .map((id) => world.npcs.find((n) => n.id === id)!)
        .filter((n) => n && !usedIds.has(n.id))
        .slice(0, MAX_GROUP_SIZE)
      if (participants.length >= 2) {
        const combinedReason = entry.reasons.map((r) => r.reason).join('; ')
        selected.push({ participants, reason: combinedReason })
        for (const p of participants) usedIds.add(p.id)
        console.log(`[Convo Merged] ${participants.map((n) => n.name).join(' + ')}: ${combinedReason.slice(0, 80)}`)
      }
    }
  }

  for (const reason of reasons) {
    if (selected.length >= MAX_NPC_CONVERSATIONS_PER_TICK) break

    const available = reason.participants.filter((n) => !usedIds.has(n.id))
    if (available.length < 2) continue

    selected.push({ participants: available.slice(0, MAX_GROUP_SIZE), reason: reason.reason })
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
  playerJoined: boolean,
  conversationReason?: string
): Promise<RawGroupResponse | null> {
  try {
    const { system, user: baseUser } = buildGroupConversationPrompt(participants, world, playerJoined, conversationReason)

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

export function applyGroupResult(result: NpcConversationResult, world: WorldState): void {
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
      // Skip self-referential knowledge (NPC learning about their own behavior)
      const firstName = npc.name.split(' ')[0].toLowerCase()
      const kLower = takeaway.knowledge.toLowerCase()
      const isSelfRef = kLower.startsWith(firstName) || kLower.startsWith(npc.name.toLowerCase())
      if (!isSelfRef) {
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
    }

    if (takeaway.moodShift) {
      updateNpcMoodGeneral(npcId, takeaway.moodShift, `after group conversation`)
    }

    // Apply tag changes from conversation (emotional/physical state shifts)
    const tagChanges = (takeaway as { tagChanges?: string[] }).tagChanges
    if (tagChanges && tagChanges.length > 0) {
      updateNpcStateFlags(npcId, tagChanges)
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

    // Mark related plan steps as completed — conversation happened, step is done
    const activeStep = npc.activePlan?.steps.find((s) => s.status === 'active')
    if (activeStep) {
      console.log(`[ConvoCheck] ${npc.name} active step: "${activeStep.description.slice(0, 40)}" target="${activeStep.target.slice(0, 20)}" participants=${result.participantIds.join(',')}`)
    }
    if (npc.activePlan?.status === 'active') {
      const newSteps = npc.activePlan.steps.map((step) => {
        if (step.status !== 'active') return step
        const matchesParticipant = result.participantIds.some((pid) => {
          const pnpc = world.npcs.find((n) => n.id === pid)
          if (!pnpc || pnpc.id === npcId) return false
          const firstName = pnpc.name.split(' ')[0].toLowerCase()
          return step.target.toLowerCase().includes(firstName) || step.description.toLowerCase().includes(firstName)
        })
        if (matchesParticipant) {
          console.log(`[Step Completed via Convo] ${npc.name}: "${step.description.slice(0, 40)}" -> done`)
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
      // Trigger replanning for ALL participants — the agreement should reshape their goals
      import('../simulation/npc-planner.js').then(({ formPlan }) => {
        for (const pid of result.participantIds) {
          const npcForReplan = world.npcs.find((n) => n.id === pid)
          if (npcForReplan) {
            formPlan(npcForReplan, world).then((plan) => {
              if (plan) {
                updateNpcPlan(pid, plan)
                import('../game/state.js').then(({ persistGame: p }) => p()).catch(() => {})
              }
            }).catch(() => {})
          }
        }
      }).catch(() => {})
    }

    // Apply conflict/physical outcomes from conversations
    if (result.outcome.conflict) {
      const conflictLower = result.outcome.conflict.toLowerCase()

      // Identify participants involved in the conflict
      for (const pid of result.participantIds) {
        const pnpc = world.npcs.find((n) => n.id === pid)
        if (!pnpc) continue
        if (!conflictLower.includes(pnpc.name.split(' ')[0].toLowerCase())) continue

        const targetNpc = result.participantIds
          .filter((id) => id !== pid)
          .map((id) => world.npcs.find((n) => n.id === id))
          .find((n) => n && conflictLower.includes(n.name.split(' ')[0].toLowerCase()))
        if (!targetNpc) continue

        // Violence: attack, fight, punch, etc.
        if (['attack', 'punch', 'fight', 'stab', 'hit', 'tackle', 'shove', 'kick'].some((w) => conflictLower.includes(w))) {
          applyPhysicalEffects(targetNpc.id, { healthDelta: -15, injury: 'bruised from confrontation' })
          updateNpcStateFlags(targetNpc.id, ['add:injured'])
          console.log(`[Conflict] ${pnpc.name} attacked ${targetNpc.name}`)
        }

        // Restraint: arrest, tie up, handcuff
        if (['arrest', 'restrain', 'tie up', 'handcuff', 'lock up', 'imprison'].some((w) => conflictLower.includes(w))) {
          applyPhysicalEffects(targetNpc.id, { statusChange: 'restrained' })
          updateNpcStateFlags(targetNpc.id, ['add:restrained'])
          console.log(`[Restrained] ${targetNpc.name} by ${pnpc.name}`)
        }

        // Seduction/intimacy: undress, seduce
        if (['undress', 'strip', 'seduce'].some((w) => conflictLower.includes(w))) {
          updateNpcStateFlags(targetNpc.id, ['add:undressed'])
          updateNpcRelationship(pid, targetNpc.id, { affection: 10 })
          console.log(`[Seduction] ${pnpc.name} seduced ${targetNpc.name}`)
        }

        // Theft
        if (['steal', 'pickpocket', 'snatch', 'take from'].some((w) => conflictLower.includes(w))) {
          const stolenItem = targetNpc.inventory[0]
          if (stolenItem) {
            transferItem(targetNpc.id, pnpc.id, stolenItem.name)
            console.log(`[Theft] ${pnpc.name} stole ${stolenItem.name} from ${targetNpc.name}`)
          }
        }

        // Relationship impact
        updateNpcRelationship(pid, targetNpc.id, { trust: -15, affection: -10 })
        updateNpcRelationship(targetNpc.id, pid, { trust: -15, fear: 10 })

        // Persist conflict effects immediately
        import('../game/state.js').then(({ persistGame: persist }) => persist()).catch(() => {})
        break
      }
    }

    if (result.outcome.item_transferred) {
      const { from, to, item } = result.outcome.item_transferred
      const fromNpc = world.npcs.find((n) => n.name.toLowerCase().includes(from.toLowerCase()) || from.toLowerCase().includes(n.name.split(' ')[0].toLowerCase()))
      const toNpc = world.npcs.find((n) => n.name.toLowerCase().includes(to.toLowerCase()) || to.toLowerCase().includes(n.name.split(' ')[0].toLowerCase()))
      if (fromNpc && toNpc) transferItem(fromNpc.id, toNpc.id, item)
    }

    // Detect meeting agreements — look for location mentions in agreement text
    if (result.outcome.agreement_reached) {
      const agrLower = result.outcome.agreement_reached.toLowerCase()
      const meetingKeywords = ['meet at', 'go to', 'come to', 'see me at', 'wait at', 'rendezvous', 'gather at']
      const hasMeetingLanguage = meetingKeywords.some((kw) => agrLower.includes(kw))
      if (hasMeetingLanguage) {
        const meetingLoc = world.locations.find((l) => agrLower.includes(l.name.toLowerCase()))
        if (meetingLoc) {
          const meetTick = world.currentTick + 4 // default: meet in ~4 ticks
          for (let i = 0; i < result.participantIds.length; i++) {
            for (let j = i + 1; j < result.participantIds.length; j++) {
              addScheduledMeeting(result.participantIds[i], {
                withId: result.participantIds[j],
                locationId: meetingLoc.id,
                tick: meetTick,
                purpose: result.outcome.agreement_reached.slice(0, 80),
              })
              addScheduledMeeting(result.participantIds[j], {
                withId: result.participantIds[i],
                locationId: meetingLoc.id,
                tick: meetTick,
                purpose: result.outcome.agreement_reached.slice(0, 80),
              })
              console.log(`[Meeting Scheduled] ${result.participantIds[i]} + ${result.participantIds[j]} at ${meetingLoc.name} tick ${meetTick}`)
            }
          }
        }
      }
    }
  }
}

// ─── Public Entry Point ───

export async function runNpcConversations(): Promise<NpcConversationResult[]> {
  const world = getWorld()
  const results: NpcConversationResult[] = []

  // Single-round conversations — always produce results immediately
  const groups = selectConversationGroups(world)
  for (const { participants: group, reason } of groups) {
    for (const npc of group) markNpcBusy(npc.id)

    const parsed = await runGroupConversationRound(group, world, [], false, reason)

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
            tagChanges: (val as { tag_changes?: string[] }).tag_changes ?? [],
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
