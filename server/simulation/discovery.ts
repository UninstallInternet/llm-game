import { v4 as uuid } from 'uuid'
import { getWorld, addNpcKnowledge } from '../game/state.js'
import { llmCall } from '../llm/client.js'
import { broadcastEvent } from '../routes/events.js'
import type { NPC, WorldState, Item, Location } from '../../shared/types.js'

interface DiscoveryResult {
  items: Array<{ name: string; tags: string[]; description: string; significance: 'mundane' | 'useful' | 'quest' }>
  observations: string[]
  newConnections: string[]
  cluesFound: string[]
}

export async function generateDiscovery(
  npc: NPC,
  location: Location,
  action: string,
  world: WorldState
): Promise<DiscoveryResult | null> {
  const mysteries = world.mysteries
    .filter((m) => !m.isResolved)
    .map((m) => m.description)
    .join('; ')

  const existingItems = location.items.map((i) => i.name).join(', ')

  const prompt = `You are a game content generator. An NPC just completed an objective that reveals new content. Generate what they discover, consistent with the world.

Setting: ${world.settingDescription}
Location: ${location.name} (${location.type}) — ${location.description}
NPC: ${npc.name} (${npc.occupation})
Action completed: ${action}
Existing items here: ${existingItems || 'none'}
Active mysteries: ${mysteries || 'none'}

Generate plausible discoveries. Keep it grounded — no magic or impossible tech.
What the NPC finds should relate to their skills and the location.
If there are mysteries, one observation should hint at a clue.

Respond with ONLY JSON:
{
  "items": [{ "name": "item name", "tags": ["tag1"], "description": "brief", "significance": "mundane|useful|quest" }],
  "observations": ["what the NPC notices (2-3 sentences)"],
  "cluesFound": ["any mystery clues discovered"]
}`

  try {
    const raw = await llmCall('simulation', prompt, 'Generate discovery.', true)
    let cleaned = raw.trim()
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
    }

    const parsed = JSON.parse(cleaned) as DiscoveryResult

    // Apply discoveries
    // Add items to location
    for (const item of parsed.items ?? []) {
      const newItem: Item = {
        id: `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: item.name,
        tags: item.tags,
        locationId: location.id,
        ownerId: null,
        description: item.description,
      }
      location.items.push(newItem)
    }

    // Add observations as NPC knowledge
    for (const obs of parsed.observations ?? []) {
      addNpcKnowledge(npc.id, [{
        id: uuid(),
        content: obs,
        source: 'observed',
        confidence: 1.0,
        importance: 0.8,
        turnLearned: world.currentTick,
        isSecret: false,
      }])
    }

    // Handle clues
    for (const clue of parsed.cluesFound ?? []) {
      addNpcKnowledge(npc.id, [{
        id: uuid(),
        content: clue,
        source: 'discovered',
        confidence: 1.0,
        importance: 0.9,
        turnLearned: world.currentTick,
        isSecret: false,
      }])

      // Mark matching mystery clues as found
      for (const mystery of world.mysteries) {
        for (const mc of mystery.clues) {
          if (!mc.foundByPlayer && mc.npcId === npc.id) {
            mc.foundByPlayer = true
          }
        }
      }
    }

    // Broadcast
    broadcastEvent({
      type: 'npc_action',
      data: {
        npcId: npc.id,
        description: `discovered something at ${location.name}: ${(parsed.observations ?? []).join(' ')}`,
      },
    })

    return parsed
  } catch (error) {
    console.error(`Discovery generation failed for ${npc.name}:`, error)
    return null
  }
}
