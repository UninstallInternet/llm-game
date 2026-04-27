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
import { buildNpcConversationPrompt } from '../llm/prompts.js'
import { broadcastEvent } from '../routes/events.js'
import {
  MAX_NPC_CONVERSATIONS_PER_TICK,
  MIN_CONVERSATION_SCORE,
} from '../../shared/constants.js'
import type { NPC, WorldState, NpcConversationResult } from '../../shared/types.js'

// ─── Active Ongoing Conversations ───

interface OngoingConversation {
  npc1Id: string
  npc2Id: string
  locationId: string
  startedAtTick: number
  history: Array<{ speaker: string; says: string }>
  roundsRemaining: number // how many more rounds before concluding
  topic: string
}

const activeConversations: OngoingConversation[] = []

const MAX_CONVERSATION_ROUNDS = 4

// ─── Pair Selection ───

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

  const activeEvents = world.events.filter((e) => !e.resolved && e.triggerDay <= world.time.day)
  for (const event of activeEvents) {
    if (event.involvedNpcIds.includes(a.id) && event.involvedNpcIds.includes(b.id)) {
      score += 0.2
      break
    }
    if (event.involvedNpcIds.includes(a.id) || event.involvedNpcIds.includes(b.id)) {
      score += 0.05
    }
  }

  if (a.factionId && b.factionId && a.factionId !== b.factionId) score += 0.15
  if (relAtoB?.type === 'rival' || relAtoB?.type === 'enemy' || relBtoA?.type === 'rival' || relBtoA?.type === 'enemy') score += 0.1
  score += Math.random() * 0.05

  // Strong recency penalty — don't repeat conversations
  const recentlySpoke = a.knowledge.some(
    (k) => k.source.includes(b.name) && k.turnLearned >= world.currentTick - 4
  ) || b.knowledge.some(
    (k) => k.source.includes(a.name) && k.turnLearned >= world.currentTick - 4
  )
  if (recentlySpoke) score *= 0.05 // almost zero — let other pairs talk instead

  return score
}

function selectConversationPairs(world: WorldState): Array<[NPC, NPC]> {
  const byLocation = new Map<string, NPC[]>()
  for (const npc of world.npcs) {
    const group = byLocation.get(npc.currentLocationId) ?? []
    group.push(npc)
    byLocation.set(npc.currentLocationId, group)
  }

  const selected: Array<[NPC, NPC]> = []
  const usedIds = new Set<string>()

  // Skip NPCs already in ongoing conversations
  for (const conv of activeConversations) {
    usedIds.add(conv.npc1Id)
    usedIds.add(conv.npc2Id)
  }

  // PRIORITY 1: Plan-driven pairs
  for (const npc of world.npcs) {
    if (isNpcBusy(npc.id) || usedIds.has(npc.id)) continue
    if (!npc.activePlan || npc.activePlan.status !== 'active') continue

    const activeStep = npc.activePlan.steps.find((s) => s.status === 'active')
    if (!activeStep) continue

    const descLower = activeStep.description.toLowerCase()
    const tLower = activeStep.target.toLowerCase()
    const targetNpc = world.npcs.find((n) => {
      if (n.id === npc.id || isNpcBusy(n.id) || usedIds.has(n.id)) return false
      if (n.currentLocationId !== npc.currentLocationId) return false
      const nameLower = n.name.toLowerCase()
      const firstName = nameLower.split(' ')[0]
      return n.id === activeStep.target || nameLower.includes(tLower) || tLower.includes(nameLower) ||
        tLower.includes(firstName) || descLower.includes(nameLower) || descLower.includes(firstName)
    })

    if (targetNpc && selected.length < MAX_NPC_CONVERSATIONS_PER_TICK) {
      selected.push([npc, targetNpc])
      usedIds.add(npc.id)
      usedIds.add(targetNpc.id)
    }
  }

  // PRIORITY 2: Score-based
  const candidates: Array<{ pair: [NPC, NPC]; score: number }> = []
  for (const [_locId, npcs] of byLocation) {
    const available = npcs.filter((n) => !isNpcBusy(n.id) && !usedIds.has(n.id))
    if (available.length < 2) continue
    for (let i = 0; i < available.length; i++) {
      for (let j = i + 1; j < available.length; j++) {
        const score = scorePair(available[i], available[j], world)
        if (score >= MIN_CONVERSATION_SCORE) {
          candidates.push({ pair: [available[i], available[j]], score })
        }
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  for (const { pair } of candidates) {
    if (selected.length >= MAX_NPC_CONVERSATIONS_PER_TICK) break
    if (usedIds.has(pair[0].id) || usedIds.has(pair[1].id)) continue
    selected.push(pair)
    usedIds.add(pair[0].id)
    usedIds.add(pair[1].id)
  }

  return selected
}

// ─── Conversation LLM Calls ───

interface RawConversationResponse {
  dialogue?: Array<{ speaker: string; says: string }>
  summary: string
  concluded: boolean
  outcome?: {
    agreement_reached?: string | null
    item_transferred?: { from: string; to: string; item: string } | null
    conflict?: string | null
  }
  npc1_takeaway: {
    knowledge: string
    mood_shift: string | null
    relationship_delta: number
    internal_reaction: string
  }
  npc2_takeaway: {
    knowledge: string
    mood_shift: string | null
    relationship_delta: number
    internal_reaction: string
  }
}

function parseConversationResponse(raw: string): RawConversationResponse {
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  }
  return JSON.parse(cleaned) as RawConversationResponse
}

async function runConversationRound(
  npc1: NPC,
  npc2: NPC,
  world: WorldState,
  priorDialogue: Array<{ speaker: string; says: string }>
): Promise<RawConversationResponse | null> {
  try {
    const { system, user: baseUser } = buildNpcConversationPrompt(npc1, npc2, world)

    // Include prior dialogue if this is a continuation
    const historyStr = priorDialogue.length > 0
      ? `\n\nCONVERSATION SO FAR (continue from here — do NOT repeat what was already said):\n${priorDialogue.map((d) => `${d.speaker}: ${d.says}`).join('\n')}\n\nContinue with 3-5 NEW exchanges. Deepen the discussion — push for specifics, make requests, negotiate terms, reveal new information. The conversation should PROGRESS. Only set concluded=true if a clear agreement or impasse is reached.`
      : ''

    const fullUser = baseUser + historyStr

    const rawResponse = await llmCall('simulation', system, fullUser, true)
    return parseConversationResponse(rawResponse)
  } catch (error) {
    console.error(`NPC conversation round failed (${npc1.name} <-> ${npc2.name}):`, error)
    return null
  }
}

// ─── Apply Results ───

function applyConversationResult(result: NpcConversationResult, world: WorldState): void {
  const npc1 = world.npcs.find((n) => n.id === result.npc1Id)
  const npc2 = world.npcs.find((n) => n.id === result.npc2Id)
  if (!npc1 || !npc2) return

  if (result.npc1Takeaway.knowledge) {
    addNpcKnowledge(result.npc1Id, [{
      id: uuid(),
      content: result.npc1Takeaway.knowledge,
      source: `conversation with ${npc2.name}`,
      confidence: 0.8,
      importance: 0.7,
      turnLearned: result.tick,
      isSecret: false,
    }])
  }
  if (result.npc1Takeaway.moodShift) {
    updateNpcMoodGeneral(result.npc1Id, result.npc1Takeaway.moodShift, `after talking with ${npc2.name}`)
  }
  const delta1 = result.npc1Takeaway.relationshipDelta
  if (delta1 !== 0) {
    updateNpcRelationship(result.npc1Id, result.npc2Id, { trust: delta1, affection: Math.round(delta1 * 0.5) }, result.npc1Takeaway.knowledge || undefined)
  }

  if (result.npc2Takeaway.knowledge) {
    addNpcKnowledge(result.npc2Id, [{
      id: uuid(),
      content: result.npc2Takeaway.knowledge,
      source: `conversation with ${npc1.name}`,
      confidence: 0.8,
      importance: 0.7,
      turnLearned: result.tick,
      isSecret: false,
    }])
  }
  if (result.npc2Takeaway.moodShift) {
    updateNpcMoodGeneral(result.npc2Id, result.npc2Takeaway.moodShift, `after talking with ${npc1.name}`)
  }
  const delta2 = result.npc2Takeaway.relationshipDelta
  if (delta2 !== 0) {
    updateNpcRelationship(result.npc2Id, result.npc1Id, { trust: delta2, affection: Math.round(delta2 * 0.5) }, result.npc2Takeaway.knowledge || undefined)
  }

  if (result.outcome) {
    if (result.outcome.agreement_reached) {
      addNpcAgreement(result.npc1Id, result.npc2Id, result.outcome.agreement_reached, result.tick)
      addNpcAgreement(result.npc2Id, result.npc1Id, result.outcome.agreement_reached, result.tick)
    }
    if (result.outcome.item_transferred) {
      const { from, to, item } = result.outcome.item_transferred
      const fromNpc = [npc1, npc2].find((n) => n.name.toLowerCase().includes(from.toLowerCase()) || from.toLowerCase().includes(n.name.split(' ')[0].toLowerCase()))
      const toNpc = [npc1, npc2].find((n) => n.name.toLowerCase().includes(to.toLowerCase()) || to.toLowerCase().includes(n.name.split(' ')[0].toLowerCase()))
      if (fromNpc && toNpc) transferItem(fromNpc.id, toNpc.id, item)
    }
  }

  // Mark plan steps targeting the other NPC — only complete if outcome was meaningful
  const hasAgreement = !!result.outcome?.agreement_reached
  const hasConflict = !!result.outcome?.conflict
  const hasOutcome = hasAgreement || hasConflict || !!result.outcome?.item_transferred

  for (const npc of [npc1, npc2]) {
    const other = npc === npc1 ? npc2 : npc1
    if (npc.activePlan?.status === 'active') {
      for (const step of npc.activePlan.steps) {
        if (step.status !== 'active') continue
        const firstName = other.name.split(' ')[0].toLowerCase()
        if (step.target.toLowerCase().includes(firstName) || step.description.toLowerCase().includes(firstName)) {
          if (hasOutcome) {
            // Real outcome achieved — mark completed
            step.status = 'completed'
            step.result = `Talked with ${other.name}: ${result.summary.slice(0, 60)}`
            console.log(`[Plan Step Done] ${npc.name}: "${step.description.slice(0, 40)}" — outcome: ${hasAgreement ? 'agreement' : hasConflict ? 'conflict' : 'transfer'}`)
          } else {
            // Conversation happened but no concrete outcome — don't complete yet
            step.result = `Discussed with ${other.name} but no resolution yet`
            console.log(`[Plan Step Pending] ${npc.name}: talked to ${other.name} but no outcome`)
          }
        }
      }
      // Advance to next step
      const next = npc.activePlan.steps.find((s) => s.status === 'pending')
      if (next) next.status = 'active'
      else if (npc.activePlan.steps.every((s) => s.status === 'completed' || s.status === 'failed' || s.status === 'skipped')) {
        npc.activePlan.status = 'completed'
      }
      updateNpcPlan(npc.id, npc.activePlan)
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
    const npc1 = world.npcs.find((n) => n.id === conv.npc1Id)
    const npc2 = world.npcs.find((n) => n.id === conv.npc2Id)
    if (!npc1 || !npc2) { activeConversations.splice(i, 1); continue }

    // Check if they're still in the same location
    if (npc1.currentLocationId !== npc2.currentLocationId) {
      markNpcFree(npc1.id)
      markNpcFree(npc2.id)
      activeConversations.splice(i, 1)
      continue
    }

    markNpcBusy(npc1.id)
    markNpcBusy(npc2.id)

    const parsed = await runConversationRound(npc1, npc2, world, conv.history)

    if (parsed) {
      // Add new dialogue to history
      for (const d of parsed.dialogue ?? []) {
        conv.history.push(d)
      }

      // Broadcast this round
      const roundSummary = (parsed.dialogue ?? []).map((d) => `${d.speaker}: ${d.says.slice(0, 60)}`).join(' | ')
      broadcastEvent({
        type: 'npc_conversation',
        data: {
          npc1Id: npc1.id, npc2Id: npc2.id, locationId: conv.locationId,
          summary: roundSummary || parsed.summary,
          npc1Thought: parsed.npc1_takeaway?.internal_reaction ?? '',
          npc2Thought: parsed.npc2_takeaway?.internal_reaction ?? '',
          npc1MoodShift: parsed.npc1_takeaway?.mood_shift ?? null,
          npc2MoodShift: parsed.npc2_takeaway?.mood_shift ?? null,
          relationshipDeltas: {
            npc1: parsed.npc1_takeaway?.relationship_delta ?? 0,
            npc2: parsed.npc2_takeaway?.relationship_delta ?? 0,
          },
        },
      })

      conv.roundsRemaining--

      // Concluded by LLM or ran out of rounds
      if (parsed.concluded || conv.roundsRemaining <= 0) {
        const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
        const result: NpcConversationResult = {
          npc1Id: npc1.id, npc2Id: npc2.id, locationId: conv.locationId,
          tick: world.currentTick,
          summary: parsed.summary || `${npc1.name} and ${npc2.name} finished their conversation.`,
          npc1Takeaway: {
            knowledge: parsed.npc1_takeaway?.knowledge ?? '',
            moodShift: parsed.npc1_takeaway?.mood_shift ?? null,
            relationshipDelta: clamp(parsed.npc1_takeaway?.relationship_delta ?? 0, -10, 10),
            internalReaction: parsed.npc1_takeaway?.internal_reaction ?? '',
          },
          npc2Takeaway: {
            knowledge: parsed.npc2_takeaway?.knowledge ?? '',
            moodShift: parsed.npc2_takeaway?.mood_shift ?? null,
            relationshipDelta: clamp(parsed.npc2_takeaway?.relationship_delta ?? 0, -10, 10),
            internalReaction: parsed.npc2_takeaway?.internal_reaction ?? '',
          },
          outcome: parsed.outcome ?? null,
        }
        applyConversationResult(result, world)
        results.push(result)
        console.log(`[NPC Chat Done] ${npc1.name} <-> ${npc2.name} (${conv.history.length} lines): ${result.summary.slice(0, 80)}`)

        markNpcFree(npc1.id)
        markNpcFree(npc2.id)
        activeConversations.splice(i, 1)
      }
    } else {
      // LLM failed — end conversation
      markNpcFree(npc1.id)
      markNpcFree(npc2.id)
      activeConversations.splice(i, 1)
    }
  }

  // 2. Start new conversations
  const pairs = selectConversationPairs(world)
  for (const [npc1, npc2] of pairs) {
    markNpcBusy(npc1.id)
    markNpcBusy(npc2.id)

    const topic = npc1.activePlan?.status === 'active' ? npc1.activePlan.goal : 'general interaction'

    const parsed = await runConversationRound(npc1, npc2, world, [])

    if (!parsed) {
      markNpcFree(npc1.id)
      markNpcFree(npc2.id)
      continue
    }

    const dialogueHistory = parsed.dialogue ?? []

    // Broadcast first round
    const roundSummary = dialogueHistory.map((d) => `${d.speaker}: ${d.says.slice(0, 60)}`).join(' | ')
    broadcastEvent({
      type: 'npc_conversation',
      data: {
        npc1Id: npc1.id, npc2Id: npc2.id, locationId: npc1.currentLocationId,
        summary: roundSummary || parsed.summary,
        npc1Thought: parsed.npc1_takeaway?.internal_reaction ?? '',
        npc2Thought: parsed.npc2_takeaway?.internal_reaction ?? '',
        npc1MoodShift: parsed.npc1_takeaway?.mood_shift ?? null,
        npc2MoodShift: parsed.npc2_takeaway?.mood_shift ?? null,
        relationshipDeltas: {
          npc1: parsed.npc1_takeaway?.relationship_delta ?? 0,
          npc2: parsed.npc2_takeaway?.relationship_delta ?? 0,
        },
      },
    })

    if (parsed.concluded) {
      // One-round conversation — apply immediately
      const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
      const result: NpcConversationResult = {
        npc1Id: npc1.id, npc2Id: npc2.id, locationId: npc1.currentLocationId,
        tick: world.currentTick,
        summary: parsed.summary,
        npc1Takeaway: {
          knowledge: parsed.npc1_takeaway?.knowledge ?? '',
          moodShift: parsed.npc1_takeaway?.mood_shift ?? null,
          relationshipDelta: clamp(parsed.npc1_takeaway?.relationship_delta ?? 0, -10, 10),
          internalReaction: parsed.npc1_takeaway?.internal_reaction ?? '',
        },
        npc2Takeaway: {
          knowledge: parsed.npc2_takeaway?.knowledge ?? '',
          moodShift: parsed.npc2_takeaway?.mood_shift ?? null,
          relationshipDelta: clamp(parsed.npc2_takeaway?.relationship_delta ?? 0, -10, 10),
          internalReaction: parsed.npc2_takeaway?.internal_reaction ?? '',
        },
        outcome: parsed.outcome ?? null,
      }
      applyConversationResult(result, world)
      results.push(result)
      console.log(`[NPC Chat] ${npc1.name} <-> ${npc2.name}: ${result.summary.slice(0, 80)}`)
      markNpcFree(npc1.id)
      markNpcFree(npc2.id)
    } else {
      // Conversation continues — track it
      activeConversations.push({
        npc1Id: npc1.id,
        npc2Id: npc2.id,
        locationId: npc1.currentLocationId,
        startedAtTick: world.currentTick,
        history: dialogueHistory,
        roundsRemaining: MAX_CONVERSATION_ROUNDS - 1,
        topic,
      })
      console.log(`[NPC Chat Started] ${npc1.name} <-> ${npc2.name}: "${topic}" (${MAX_CONVERSATION_ROUNDS} rounds max)`)
    }
  }

  return results
}
