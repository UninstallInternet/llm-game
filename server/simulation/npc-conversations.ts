import { v4 as uuid } from 'uuid'
import {
  getWorld,
  getPlayer,
  addNpcKnowledge,
  updateNpcRelationship,
  updateNpcMoodGeneral,
} from '../game/state.js'
import { llmCall } from '../llm/client.js'
import { buildNpcConversationPrompt } from '../llm/prompts.js'
import { broadcastEvent } from '../routes/events.js'
import {
  MAX_NPC_CONVERSATIONS_PER_TICK,
  MIN_CONVERSATION_SCORE,
} from '../../shared/constants.js'
import type { NPC, WorldState, NpcConversationResult } from '../../shared/types.js'

// ─── Pair Selection ───

function scorePair(a: NPC, b: NPC, world: WorldState): number {
  let score = 0

  // Relationship intensity (strong feelings = more likely to interact)
  const relAtoB = a.relationships.find((r) => r.targetNpcId === b.id)
  const relBtoA = b.relationships.find((r) => r.targetNpcId === a.id)
  const intensityA = relAtoB
    ? (Math.abs(relAtoB.trust) + Math.abs(relAtoB.affection) + Math.abs(relAtoB.respect) + relAtoB.fear) / 400
    : 0
  const intensityB = relBtoA
    ? (Math.abs(relBtoA.trust) + Math.abs(relBtoA.affection) + Math.abs(relBtoA.respect) + relBtoA.fear) / 400
    : 0
  score += ((intensityA + intensityB) / 2) * 0.25

  // Knowledge asymmetry (different info = more interesting conversation)
  const aTopics = new Set(a.knowledge.filter((k) => !k.isSecret).map((k) => k.content))
  const bTopics = new Set(b.knowledge.filter((k) => !k.isSecret).map((k) => k.content))
  const unique = [...aTopics].filter((t) => !bTopics.has(t)).length +
    [...bTopics].filter((t) => !aTopics.has(t)).length
  score += Math.min(unique / 10, 0.25)

  // Event involvement (both involved in active events)
  const activeEvents = world.events.filter(
    (e) => !e.resolved && e.triggerDay <= world.time.day
  )
  for (const event of activeEvents) {
    if (event.involvedNpcIds.includes(a.id) && event.involvedNpcIds.includes(b.id)) {
      score += 0.2
      break
    }
    if (event.involvedNpcIds.includes(a.id) || event.involvedNpcIds.includes(b.id)) {
      score += 0.05
    }
  }

  // Goal conflict (cross-faction intrigue)
  if (a.factionId && b.factionId && a.factionId !== b.factionId) {
    score += 0.15
  }

  // Rivalry/enemy bonus
  if (relAtoB?.type === 'rival' || relAtoB?.type === 'enemy' ||
      relBtoA?.type === 'rival' || relBtoA?.type === 'enemy') {
    score += 0.1
  }

  // Random jitter
  score += Math.random() * 0.05

  // Recency penalty (talked recently → reduce score)
  const recentlySpoke =
    a.knowledge.some(
      (k) => k.source.includes(b.name) && k.turnLearned >= world.currentTick - 2
    ) ||
    b.knowledge.some(
      (k) => k.source.includes(a.name) && k.turnLearned >= world.currentTick - 2
    )
  if (recentlySpoke) {
    score *= 0.3
  }

  return score
}

function selectConversationPairs(world: WorldState): Array<[NPC, NPC]> {
  // Group NPCs by location
  const byLocation = new Map<string, NPC[]>()
  for (const npc of world.npcs) {
    const group = byLocation.get(npc.currentLocationId) ?? []
    group.push(npc)
    byLocation.set(npc.currentLocationId, group)
  }

  // Score all co-located pairs
  const candidates: Array<{ pair: [NPC, NPC]; score: number }> = []
  for (const [_locId, npcs] of byLocation) {
    if (npcs.length < 2) continue
    for (let i = 0; i < npcs.length; i++) {
      for (let j = i + 1; j < npcs.length; j++) {
        const score = scorePair(npcs[i], npcs[j], world)
        if (score >= MIN_CONVERSATION_SCORE) {
          candidates.push({ pair: [npcs[i], npcs[j]], score })
        }
      }
    }
  }

  // Sort by score descending, pick top pairs (no NPC in multiple)
  candidates.sort((a, b) => b.score - a.score)

  const selected: Array<[NPC, NPC]> = []
  const usedIds = new Set<string>()

  for (const { pair } of candidates) {
    if (selected.length >= MAX_NPC_CONVERSATIONS_PER_TICK) break
    if (usedIds.has(pair[0].id) || usedIds.has(pair[1].id)) continue
    selected.push(pair)
    usedIds.add(pair[0].id)
    usedIds.add(pair[1].id)
  }

  return selected
}

// ─── LLM Call + Parse ───

interface RawConversationResponse {
  summary: string
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

async function runConversation(
  npc1: NPC,
  npc2: NPC,
  world: WorldState
): Promise<NpcConversationResult | null> {
  try {
    const { system, user } = buildNpcConversationPrompt(npc1, npc2, world)
    const rawResponse = await llmCall('simulation', system, user, true)
    const parsed = parseConversationResponse(rawResponse)

    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

    return {
      npc1Id: npc1.id,
      npc2Id: npc2.id,
      locationId: npc1.currentLocationId,
      tick: world.currentTick,
      summary: parsed.summary || `${npc1.name} and ${npc2.name} had a conversation.`,
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
    }
  } catch (error) {
    console.error(`NPC conversation failed (${npc1.name} <-> ${npc2.name}):`, error)
    return null
  }
}

// ─── Apply Results ───

function applyConversationResult(result: NpcConversationResult, world: WorldState): void {
  const npc1 = world.npcs.find((n) => n.id === result.npc1Id)
  const npc2 = world.npcs.find((n) => n.id === result.npc2Id)
  if (!npc1 || !npc2) return

  // NPC1 takeaway
  if (result.npc1Takeaway.knowledge) {
    addNpcKnowledge(result.npc1Id, [
      {
        id: uuid(),
        content: result.npc1Takeaway.knowledge,
        source: `conversation with ${npc2.name}`,
        confidence: 0.8,
        importance: 0.6,
        turnLearned: result.tick,
        isSecret: false,
      },
    ])
  }
  if (result.npc1Takeaway.moodShift) {
    updateNpcMoodGeneral(
      result.npc1Id,
      result.npc1Takeaway.moodShift,
      `after talking with ${npc2.name}`
    )
  }
  const delta1 = result.npc1Takeaway.relationshipDelta
  if (delta1 !== 0) {
    updateNpcRelationship(
      result.npc1Id,
      result.npc2Id,
      { trust: delta1, affection: Math.round(delta1 * 0.5) },
      result.npc1Takeaway.knowledge || undefined
    )
  }

  // NPC2 takeaway
  if (result.npc2Takeaway.knowledge) {
    addNpcKnowledge(result.npc2Id, [
      {
        id: uuid(),
        content: result.npc2Takeaway.knowledge,
        source: `conversation with ${npc1.name}`,
        confidence: 0.8,
        importance: 0.6,
        turnLearned: result.tick,
        isSecret: false,
      },
    ])
  }
  if (result.npc2Takeaway.moodShift) {
    updateNpcMoodGeneral(
      result.npc2Id,
      result.npc2Takeaway.moodShift,
      `after talking with ${npc1.name}`
    )
  }
  const delta2 = result.npc2Takeaway.relationshipDelta
  if (delta2 !== 0) {
    updateNpcRelationship(
      result.npc2Id,
      result.npc1Id,
      { trust: delta2, affection: Math.round(delta2 * 0.5) },
      result.npc2Takeaway.knowledge || undefined
    )
  }
}

// ─── Public Entry Point ───

export async function runNpcConversations(): Promise<NpcConversationResult[]> {
  const world = getWorld()
  const pairs = selectConversationPairs(world)
  const results: NpcConversationResult[] = []

  for (const [npc1, npc2] of pairs) {
    const result = await runConversation(npc1, npc2, world)
    if (!result) continue

    applyConversationResult(result, world)
    results.push(result)

    console.log(`[NPC Chat] ${npc1.name} <-> ${npc2.name}: ${result.summary}`)

    broadcastEvent({
      type: 'npc_conversation',
      data: {
        npc1Id: result.npc1Id,
        npc2Id: result.npc2Id,
        locationId: result.locationId,
        summary: result.summary,
      },
    })
  }

  return results
}
