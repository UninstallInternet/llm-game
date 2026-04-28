import { llmCall } from './client.js'
import type { JudgeResult, NPC, Location, Item, PhysicalState } from '../../shared/types.js'
import { TAG_EFFECTS } from '../../shared/constants.js'

export interface JudgeInput {
  actor: { name: string; occupation: string; tags: string[]; health?: number; injuries?: string[] }
  action: string
  target: { name: string; tags: string[]; health?: number }
  environment: { name: string; tags: string[] }
  context: string
}

export interface GameMasterResult extends JudgeResult {
  effects: {
    actorHealthDelta: number
    targetHealthDelta: number
    actorEnergyDelta: number
    actorInjury: string | null
    targetInjury: string | null
    actorStatusChange: PhysicalState['status'] | null
    targetStatusChange: PhysicalState['status'] | null
    itemConsumed: boolean
    relationshipImpact: number
    actorTagChanges: string[]
    targetTagChanges: string[]
  }
}

function buildGameMasterPrompt(input: JudgeInput): string {
  const actorHealth = input.actor.health != null ? `Health: ${input.actor.health}/100` : ''
  const actorInjuries = input.actor.injuries?.length ? `Injuries: ${input.actor.injuries.join(', ')}` : ''
  const targetHealth = input.target.health != null ? `Health: ${input.target.health}/100` : ''

  // Compute tag modifiers for the actor
  const actorTagMods: string[] = []
  for (const tag of input.actor.tags) {
    const effect = TAG_EFFECTS[tag]
    if (effect?.probabilityModifiers) {
      const mods = Object.entries(effect.probabilityModifiers)
        .filter(([, v]) => v !== 0 && v !== undefined)
        .map(([k, v]) => `${k}: ${v! > 0 ? '+' : ''}${v}%`)
      if (mods.length > 0) actorTagMods.push(`${tag} (${mods.join(', ')})`)
    }
  }
  const tagModStr = actorTagMods.length > 0 ? `\nTag modifiers on actor: ${actorTagMods.join('; ')}. Adjust probability accordingly.` : ''

  return `You are the Game Master of a text adventure. You adjudicate ANY action an NPC attempts — physical, social, technical, creative, or combat. Be realistic and grounded. No magic.

Actor: ${input.actor.name} (${input.actor.occupation}) [${input.actor.tags.join(', ')}] ${actorHealth} ${actorInjuries}
Action: ${input.action}
Target: ${input.target.name} [${input.target.tags.join(', ')}] ${targetHealth}
Environment: ${input.environment.name} [${input.environment.tags.join(', ')}]
Context: ${input.context}${tagModStr}

PROBABILITY BANDS:
- 5-15%: Far outside capabilities, no skill, bad conditions
- 25-40%: Adjacent skill, improvised, some chance
- 50-65%: Competent with adequate tools/skills
- 75-90%: Expert, ideal tools, favorable conditions
- Injuries/low health reduce probability by 10-30%

For COMBAT: Consider size, training, weapons, injuries, surprise. Unarmed vs armed is very unfavorable.
For SOCIAL (charm, seduce, intimidate, deceive): Consider personality match, relationship, context. Charisma matters.
For TECHNICAL: Consider occupation tags, tools available, complexity.

EFFECT RULES (CRITICAL — follow these exactly):
- COMBAT (punch/kick/stab/slash/shoot): targetHealthDelta MUST be -5 to -40. A punch = -5 to -15. A sword = -15 to -35. Set targetInjury describing the wound.
- SOCIAL (talk/charm/persuade/intimidate): healthDeltas should be 0. Use relationshipImpact instead.
- HEALING (heal/bandage/treat): targetHealthDelta should be POSITIVE (+10 to +30).
- RESTRAINT (arrest/tie/restrain): set targetStatusChange to "restrained".
- SEDUCTION (seduce/undress): set relationshipImpact, no health change.
- On FAILURE: the actor may take damage instead. Flip who gets hurt.
- If target HP would reach 0: set targetStatusChange to "unconscious" or "dead".
- NEVER leave targetHealthDelta at 0 for combat actions that succeed.
- ALWAYS set appropriate tags on affected characters (see tag fields below).

Respond with ONLY JSON:
{
  "probability": 1-99,
  "reasoning": "why this probability (1 sentence)",
  "narrativeHint": "what happens (1-2 sentences, vivid and specific)",
  "effects": {
    "actorHealthDelta": -3,
    "targetHealthDelta": -15,
    "actorEnergyDelta": -5,
    "actorInjury": null,
    "targetInjury": "slash wound on the arm",
    "actorStatusChange": null,
    "targetStatusChange": null,
    "itemConsumed": false,
    "relationshipImpact": -5,
    "actorTagChanges": [],
    "targetTagChanges": ["add:injured", "add:bleeding"]
  }
}

TAG FORMAT: "add:tagname" or "remove:tagname". You can use ANY tag that describes the character's visible state — you are not limited to a fixed list.
COMMON TAGS: injured, bleeding, scared, angry, armed, drunk, restrained, undressed, disguised, wet, hiding, excited, distressed, confident, suspicious, aroused, depressed, furious, panicked, focused, grieving, determined.
CUSTOM TAGS: You can invent any tag that fits: "add:covered_in_mud", "add:on_fire", "add:hallucinating", "add:love_struck", "add:starving", "add:humiliated", "add:triumphant", etc.
Set tags that reflect what HAPPENED. Every significant action should produce at least one tag change.`
}

function rollOutcome(probability: number): JudgeResult['outcome'] {
  const roll = Math.random() * 100
  if (roll < probability * 0.6) return 'strong_success'
  if (roll < probability) return 'partial_success'
  return 'failure'
}

const DEFAULT_EFFECTS: GameMasterResult['effects'] = {
  actorHealthDelta: 0,
  targetHealthDelta: 0,
  actorEnergyDelta: -5,
  actorInjury: null,
  targetInjury: null,
  actorStatusChange: null,
  targetStatusChange: null,
  itemConsumed: false,
  relationshipImpact: 0,
  actorTagChanges: [],
  targetTagChanges: [],
}

export async function judgeAction(input: JudgeInput): Promise<GameMasterResult> {
  try {
    const prompt = buildGameMasterPrompt(input)
    const raw = await llmCall('simulation', prompt, 'Judge this action.', true)

    let cleaned = raw.trim()
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
    }

    const parsed = JSON.parse(cleaned) as {
      probability: number
      reasoning: string
      narrativeHint: string
      effects?: Partial<GameMasterResult['effects']>
    }

    const probability = Math.max(1, Math.min(99, parsed.probability))
    const outcome = rollOutcome(probability)

    // On failure, flip some effects (e.g., the actor takes damage instead of dealing it)
    const effects = { ...DEFAULT_EFFECTS, ...(parsed.effects ?? {}) }

    // FORCE minimum effects for physical actions on success — LLM often returns 0
    const actionLow = input.action.toLowerCase()
    const isCombat = ['attack', 'stab', 'slash', 'punch', 'kick', 'hit', 'fight', 'strike', 'shoot', 'cut', 'shove', 'tackle', 'knock'].some((w) => actionLow.includes(w))
    const isHealing = ['heal', 'bandage', 'treat', 'mend', 'tend'].some((w) => actionLow.includes(w))
    const isRestraint = ['arrest', 'restrain', 'tie', 'handcuff', 'imprison'].some((w) => actionLow.includes(w))

    if (outcome !== 'failure') {
      if (isCombat && effects.targetHealthDelta === 0) {
        effects.targetHealthDelta = outcome === 'strong_success' ? -20 : -10
        if (!effects.targetInjury) effects.targetInjury = outcome === 'strong_success' ? 'deep wound from combat' : 'bruise from combat'
      }
      if (isHealing && effects.targetHealthDelta <= 0) {
        effects.targetHealthDelta = outcome === 'strong_success' ? 25 : 15
      }
      if (isRestraint && !effects.targetStatusChange) {
        effects.targetStatusChange = 'restrained'
      }
    }

    if (outcome === 'failure') {
      // If this was combat, the actor might get hurt instead
      if (effects.targetHealthDelta < 0) {
        effects.actorHealthDelta = Math.round(effects.targetHealthDelta * 0.5)
        effects.targetHealthDelta = 0
        effects.actorInjury = effects.targetInjury
        effects.targetInjury = null
      }
      effects.actorStatusChange = null
      effects.targetStatusChange = null
    } else if (outcome === 'partial_success') {
      // Reduce the magnitude of effects
      effects.targetHealthDelta = Math.round(effects.targetHealthDelta * 0.5)
      effects.actorHealthDelta = Math.round(effects.actorHealthDelta * 0.5)
      effects.targetStatusChange = null // no knockout on partial
    }

    return {
      probability,
      reasoning: parsed.reasoning,
      outcome,
      narrativeHint: parsed.narrativeHint,
      effects,
    }
  } catch {
    const outcome = rollOutcome(50)
    return {
      probability: 50,
      reasoning: 'Could not assess — defaulting to even odds',
      outcome,
      narrativeHint: outcome === 'failure' ? 'The attempt did not succeed.' : 'It partially worked.',
      effects: { ...DEFAULT_EFFECTS },
    }
  }
}

export function preCheckAction(
  npc: NPC,
  _action: string,
  targetLocation: Location | null,
  requiredItem: Item | null
): { pass: boolean; reason: string } {
  if (npc.physical.status === 'dead') {
    return { pass: false, reason: `${npc.name} is dead` }
  }
  if (npc.physical.status === 'unconscious') {
    return { pass: false, reason: `${npc.name} is unconscious` }
  }
  if (npc.physical.status === 'restrained') {
    return { pass: false, reason: `${npc.name} is restrained` }
  }
  if (targetLocation && npc.currentLocationId !== targetLocation.id) {
    return { pass: false, reason: `${npc.name} is not at ${targetLocation.name}` }
  }
  if (requiredItem && !npc.inventory.some((i) => i.id === requiredItem.id)) {
    return { pass: false, reason: `${npc.name} doesn't have ${requiredItem.name}` }
  }
  return { pass: true, reason: 'OK' }
}

export async function searchContainer(
  npc: NPC,
  location: Location,
  containerId: string,
  currentTick = 0
): Promise<Item | null> {
  const container = location.containers.find((c) => c.id === containerId)
  if (!container) return null

  // Check cooldown for re-search
  const searchCount = container.searchCount ?? 0
  const lastSearchTick = container.lastSearchTick ?? 0
  if (searchCount > 0 && currentTick - lastSearchTick < 6) return null

  // Update search tracking
  container.searchCount = searchCount + 1
  container.lastSearchTick = currentTick

  const hasSkillMatch = npc.occupationTags.some((tag) =>
    container.expectedItemTypes.some((expected) =>
      tag.toLowerCase().includes(expected.toLowerCase()) ||
      expected.toLowerCase().includes(tag.toLowerCase())
    )
  )

  const baseChance = 0.6
  const skillBonus = hasSkillMatch ? 0.2 : 0
  const difficultyPenalty = container.searchDifficulty * 0.08
  const healthPenalty = npc.physical.health < 50 ? 0.15 : 0
  const diminish = Math.pow(0.7, searchCount) // each re-search is harder

  const successChance = Math.max(0.05, (baseChance + skillBonus - difficultyPenalty - healthPenalty) * diminish)

  if (Math.random() > successChance) return null

  try {
    const prompt = `You are a game item generator. ${npc.name} (${npc.occupation}) searches "${container.name}" at "${location.name}" (${location.type}).
Expected items: ${container.expectedItemTypes.join(', ')}.
Location tags: ${location.tags.join(', ')}.

Generate ONE plausible, grounded item. Respond with ONLY JSON:
{"name": "item name", "tags": ["tag1"], "description": "brief"}`

    const raw = await llmCall('simulation', prompt, 'Generate item.', true)
    let cleaned = raw.trim()
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
    }

    const parsed = JSON.parse(cleaned) as { name: string; tags: string[]; description: string }

    return {
      id: `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: parsed.name,
      tags: parsed.tags,
      locationId: null,
      ownerId: npc.id,
      description: parsed.description,
    }
  } catch {
    return null
  }
}
