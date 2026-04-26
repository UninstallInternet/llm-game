import { llmCall } from './client.js'
import type { JudgeResult, NPC, Location, Item } from '../../shared/types.js'

interface JudgeInput {
  actor: { name: string; occupation: string; tags: string[] }
  action: string
  target: { name: string; tags: string[] }
  environment: { name: string; tags: string[] }
  context: string
}

function buildJudgePrompt(input: JudgeInput): string {
  return `You are a game physics judge. Given an actor, action, target, and environment, assess the probability of success. Be realistic and grounded — no magic, no impossible technology.

Actor: ${input.actor.name} (${input.actor.occupation}) [tags: ${input.actor.tags.join(', ')}]
Action: ${input.action}
Target: ${input.target.name} [tags: ${input.target.tags.join(', ')}]
Environment: ${input.environment.name} [tags: ${input.environment.tags.join(', ')}]
Context: ${input.context}

PROBABILITY BANDS:
- 5-15%: Acting far outside capabilities, no relevant skills/tools
- 25-40%: Adjacent skill, improvised approach
- 50-65%: Competent with adequate tools
- 75-90%: Expert with proper tools in good conditions

Respond with ONLY JSON (no markdown):
{
  "probability": 1-99,
  "reasoning": "brief explanation of probability",
  "narrativeHint": "brief description of what happens"
}`
}

function rollOutcome(probability: number): JudgeResult['outcome'] {
  const roll = Math.random() * 100
  if (roll < probability * 0.6) return 'strong_success'
  if (roll < probability) return 'partial_success'
  return 'failure'
}

export async function judgeAction(input: JudgeInput): Promise<JudgeResult> {
  try {
    const prompt = buildJudgePrompt(input)
    const raw = await llmCall('simulation', prompt, 'Judge this action.', true)

    let cleaned = raw.trim()
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
    }

    const parsed = JSON.parse(cleaned) as { probability: number; reasoning: string; narrativeHint: string }
    const probability = Math.max(1, Math.min(99, parsed.probability))
    const outcome = rollOutcome(probability)

    return {
      probability,
      reasoning: parsed.reasoning,
      outcome,
      narrativeHint: parsed.narrativeHint,
    }
  } catch (error) {
    // Fallback: 50/50 with generic narrative
    const outcome = rollOutcome(50)
    return {
      probability: 50,
      reasoning: 'Could not assess — defaulting to even odds',
      outcome,
      narrativeHint: outcome === 'failure' ? 'The attempt did not succeed.' : 'The attempt succeeded, barely.',
    }
  }
}

// Deterministic pre-checks before calling the LLM judge
export function preCheckAction(
  npc: NPC,
  action: string,
  targetLocation: Location | null,
  requiredItem: Item | null
): { pass: boolean; reason: string } {
  // Must be at the location
  if (targetLocation && npc.currentLocationId !== targetLocation.id) {
    return { pass: false, reason: `${npc.name} is not at ${targetLocation.name}` }
  }

  // Must have required item
  if (requiredItem && !npc.inventory.some((i) => i.id === requiredItem.id)) {
    return { pass: false, reason: `${npc.name} doesn't have ${requiredItem.name}` }
  }

  return { pass: true, reason: 'OK' }
}

// Search a location container for items — deterministic + LLM for discovery
export async function searchContainer(
  npc: NPC,
  location: Location,
  containerId: string
): Promise<Item | null> {
  const container = location.containers.find((c) => c.id === containerId)
  if (!container) return null

  // Already searched
  if (container.searched) return null

  // Mark as searched
  container.searched = true

  // Check if NPC's occupation tags match expected item types
  const hasSkillMatch = npc.occupationTags.some((tag) =>
    container.expectedItemTypes.some((expected) =>
      tag.toLowerCase().includes(expected.toLowerCase()) ||
      expected.toLowerCase().includes(tag.toLowerCase())
    )
  )

  const baseChance = 0.6
  const skillBonus = hasSkillMatch ? 0.2 : 0
  const difficultyPenalty = container.searchDifficulty * 0.08

  const successChance = Math.max(0.1, baseChance + skillBonus - difficultyPenalty)

  if (Math.random() > successChance) return null

  // Generate a plausible item based on container type
  try {
    const prompt = `You are a game item generator. An NPC named ${npc.name} (${npc.occupation}) is searching a "${container.name}" at "${location.name}" (${location.type}).
Expected item types in this container: ${container.expectedItemTypes.join(', ')}.
Location tags: ${location.tags.join(', ')}.

Generate ONE plausible item they find. Keep it grounded and realistic for the setting.

Respond with ONLY JSON (no markdown):
{
  "name": "item name",
  "tags": ["tag1", "tag2"],
  "description": "brief description"
}`

    const raw = await llmCall('simulation', prompt, 'Generate an item.', true)
    let cleaned = raw.trim()
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
    }

    const parsed = JSON.parse(cleaned) as { name: string; tags: string[]; description: string }

    const item: Item = {
      id: `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: parsed.name,
      tags: parsed.tags,
      locationId: null,
      ownerId: npc.id,
      description: parsed.description,
    }

    return item
  } catch {
    return null
  }
}
