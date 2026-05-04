import type { NPC, WorldState, BeliefEntry } from '../../shared/types.js'
import { updateNpcBeliefs } from '../game/state.js'

// ─── Social Strategy Types ───

export type SocialStrategy =
  | 'recruit'
  | 'lie_elaborate'
  | 'lie_simple'
  | 'deflect'
  | 'flee'
  | 'honest'
  | 'probe'
  | 'ignore'

export interface EncounterAssessment {
  threatLevel: number // 0-1
  relevance: number   // 0-1 — how relevant is this NPC to my plan?
  strategy: SocialStrategy
  reasoning: string
}

// ─── Personality Helpers ───

function hasTrait(npc: NPC, ...keywords: string[]): boolean {
  return npc.personality.traits.some((t) =>
    keywords.some((k) => t.toLowerCase().includes(k))
  )
}

function honestyScore(npc: NPC): number {
  if (hasTrait(npc, 'honest', 'truthful', 'sincere', 'principled')) return 0.8
  if (hasTrait(npc, 'deceptive', 'manipulative', 'cunning', 'sly')) return 0.2
  return 0.5
}

function courageScore(npc: NPC): number {
  if (hasTrait(npc, 'brave', 'bold', 'courageous', 'fearless')) return 0.8
  if (hasTrait(npc, 'cowardly', 'timid', 'nervous', 'anxious')) return 0.2
  return 0.5
}

function paranoiaScore(npc: NPC): number {
  if (hasTrait(npc, 'paranoid', 'suspicious', 'distrustful', 'wary')) return 0.8
  if (hasTrait(npc, 'trusting', 'naive', 'open', 'gullible')) return 0.2
  return 0.5
}

// ─── Encounter Assessment (deterministic, no LLM) ───

export function assessEncounter(
  npc: NPC,
  other: NPC,
  world: WorldState // eslint-disable-line @typescript-eslint/no-unused-vars
): EncounterAssessment {
  const rel = npc.relationships.find((r) => r.targetNpcId === other.id)

  // Threat level based on relationship + personality
  let threat = 0.3 // baseline
  if (rel) {
    threat += (1 - (rel.trust + 100) / 200) * 0.3 // low trust = more threat
    threat += (rel.fear / 100) * 0.2
    if (rel.type === 'rival' || rel.type === 'enemy') threat += 0.2
  }
  if (other.factionId && npc.factionId && other.factionId !== npc.factionId) {
    threat += 0.1
  }
  threat = Math.min(1.0, threat)

  // Relevance to current plan
  let relevance = 0
  if (npc.activePlan?.status === 'active') {
    const planMentionsOther = npc.activePlan.steps.some(
      (s) => s.target.includes(other.id) || s.target.toLowerCase().includes(other.name.toLowerCase())
    )
    if (planMentionsOther) relevance = 0.8
    if (npc.activePlan.allies.includes(other.id)) relevance = 0.9
  }

  // Choose strategy based on personality + context
  const honesty = honestyScore(npc)
  const courage = courageScore(npc)
  const paranoia = paranoiaScore(npc)
  const hasSecret = npc.activePlan?.status === 'active'

  let strategy: SocialStrategy
  let reasoning: string

  if (relevance > 0.7 && npc.activePlan?.allies.includes(other.id)) {
    strategy = 'honest'
    reasoning = `${other.name} is an ally in my plan`
  } else if (relevance > 0.5 && rel && rel.trust > 30) {
    strategy = 'recruit'
    reasoning = `${other.name} could help with my plan and I trust them`
  } else if (!hasSecret) {
    strategy = 'honest'
    reasoning = 'Nothing to hide'
  } else if (honesty > 0.7 && rel && rel.trust > 40) {
    strategy = 'honest'
    reasoning = 'Too honest to lie, and trust is decent'
  } else if (threat > 0.7 && courage < 0.4) {
    strategy = 'flee'
    reasoning = 'Too dangerous, not brave enough to face them'
  } else if (threat > 0.5) {
    strategy = honesty < 0.4 ? 'lie_elaborate' : 'lie_simple'
    reasoning = 'Threat is high, need to deflect'
  } else if (paranoia > 0.6) {
    strategy = 'deflect'
    reasoning = 'Suspicious by nature, keeping cards close'
  } else {
    strategy = 'deflect'
    reasoning = 'Playing it safe'
  }

  return { threatLevel: threat, relevance, strategy, reasoning }
}

// ─── Belief Evaluation (deterministic, no LLM) ───

export function evaluateClaim(
  listener: NPC,
  claim: string,
  sourceNpcId: string,
  world: WorldState
): { acceptance: number; reasoning: string } {
  const rel = listener.relationships.find((r) => r.targetNpcId === sourceNpcId)
  const source = world.npcs.find((n) => n.id === sourceNpcId)

  // Base acceptance from trust
  let acceptance = rel ? (rel.trust + 100) / 200 : 0.5

  // Personality modifiers
  const paranoia = paranoiaScore(listener)
  acceptance *= 1 - paranoia * 0.4

  // Cross-reference with existing knowledge
  const contradicts = listener.knowledge.some(
    (k) => k.confidence > 0.7 && claimContradicts(k.content, claim)
  )
  if (contradicts) {
    acceptance *= 0.3
  }

  // Corroboration from other sources
  const corroborated = listener.knowledge.some(
    (k) => k.source !== source?.name && claimCorroborates(k.content, claim)
  )
  if (corroborated) {
    acceptance *= 1.5
  }

  acceptance = Math.max(0, Math.min(1, acceptance))

  const reasoning = contradicts
    ? `Contradicts what I already know (acceptance: ${Math.round(acceptance * 100)}%)`
    : corroborated
      ? `Matches what I heard from others (acceptance: ${Math.round(acceptance * 100)}%)`
      : `Based on trust level (acceptance: ${Math.round(acceptance * 100)}%)`

  return { acceptance, reasoning }
}

// Simple heuristic for contradiction/corroboration detection
function claimContradicts(existing: string, claim: string): boolean {
  const negatives = ['not', 'never', 'didn\'t', 'isn\'t', 'wasn\'t', 'no']
  const existingWords = new Set(existing.toLowerCase().split(/\s+/))
  const claimWords = claim.toLowerCase().split(/\s+/)

  // If one has a negative where the other doesn't on the same topic
  const existingHasNeg = negatives.some((n) => existingWords.has(n))
  const claimHasNeg = negatives.some((n) => claimWords.includes(n))

  // Very rough: if they share 3+ significant words but differ in negation
  const sharedWords = claimWords.filter(
    (w) => w.length > 4 && existingWords.has(w)
  )
  if (sharedWords.length >= 3 && existingHasNeg !== claimHasNeg) return true

  return false
}

function claimCorroborates(existing: string, claim: string): boolean {
  const existingWords = new Set(existing.toLowerCase().split(/\s+/))
  const claimWords = claim.toLowerCase().split(/\s+/)
  const sharedWords = claimWords.filter(
    (w) => w.length > 4 && existingWords.has(w)
  )
  return sharedWords.length >= 3
}

// ─── Add Belief to NPC ───

export function addBelief(
  npc: NPC,
  proposition: string,
  sourceNpcId: string,
  confidence: number,
  tick: number
): void {
  const existingIdx = npc.beliefs.findIndex(
    (b) => b.proposition.toLowerCase() === proposition.toLowerCase()
  )

  let updatedBeliefs: BeliefEntry[]

  if (existingIdx !== -1) {
    const existing = npc.beliefs[existingIdx]
    if (existing.corroboratedBy.includes(sourceNpcId)) return
    updatedBeliefs = npc.beliefs.map((b, i) =>
      i !== existingIdx ? b : {
        ...b,
        corroboratedBy: [...b.corroboratedBy, sourceNpcId],
        confidence: Math.min(1, b.confidence + 0.1),
      }
    )
  } else {
    const newBelief: BeliefEntry = {
      proposition,
      source: sourceNpcId,
      confidence,
      corroboratedBy: [],
      contradictedBy: [],
      tick,
    }
    const base = npc.beliefs.length >= 30 ? npc.beliefs.slice(1) : npc.beliefs
    updatedBeliefs = [...base, newBelief]
  }

  updateNpcBeliefs(npc.id, updatedBeliefs)
}
