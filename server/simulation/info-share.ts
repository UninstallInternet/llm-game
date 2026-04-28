import { v4 as uuid } from 'uuid'
import { getWorld, addNpcKnowledge } from '../game/state.js'
import { INFO_SHARE_PROBABILITY, MAX_KNOWLEDGE_PER_NPC } from '../../shared/constants.js'
import type { KnowledgeEntry } from '../../shared/types.js'

interface InfoShare {
  fromNpcId: string
  toNpcId: string
  summary: string
}

export function propagateInfo(): InfoShare[] {
  const world = getWorld()
  const shares: InfoShare[] = []

  // Group NPCs by location
  const byLocation = new Map<string, string[]>()
  for (const npc of world.npcs) {
    const existing = byLocation.get(npc.currentLocationId) ?? []
    existing.push(npc.id)
    byLocation.set(npc.currentLocationId, existing)
  }

  // For each location with 2+ NPCs, maybe share info
  for (const [_locationId, npcIds] of byLocation) {
    if (npcIds.length < 2) continue

    for (const speakerId of npcIds) {
      const speaker = world.npcs.find((n) => n.id === speakerId)
      if (!speaker) continue

      // Skip if speaker has no shareable knowledge
      const shareable = speaker.knowledge.filter(
        (k) => !k.isSecret && k.confidence > 0.3
      )
      if (shareable.length === 0) continue

      for (const listenerId of npcIds) {
        if (listenerId === speakerId) continue
        if (Math.random() > INFO_SHARE_PROBABILITY) continue

        const listener = world.npcs.find((n) => n.id === listenerId)
        if (!listener) continue
        if (listener.knowledge.length >= MAX_KNOWLEDGE_PER_NPC) continue

        // Pick a random piece of knowledge to share
        const toShare = shareable[Math.floor(Math.random() * shareable.length)]

        // Check if listener already knows this
        const alreadyKnows = listener.knowledge.some(
          (k) => k.content === toShare.content
        )
        if (alreadyKnows) continue

        // Skip noise: self-referential, first-person, search failures, player actions, private reflections
        const listenerFirstName = listener.name.split(' ')[0].toLowerCase()
        const contentLower = toShare.content.toLowerCase()
        if (contentLower.startsWith(listenerFirstName) || contentLower.startsWith(listener.name.toLowerCase())) continue
        if (contentLower.startsWith('i ') || contentLower.startsWith('i\'') || contentLower.includes(' is my ')) continue
        if (contentLower.startsWith('searched ') || contentLower.includes('nothing useful found')) continue
        if (contentLower.startsWith('the visitor ') || contentLower.includes('visitor investigate')) continue
        if (contentLower.startsWith('self-reflection:') || toShare.source.startsWith('self —')) continue
        if (contentLower.startsWith('at ') && contentLower.includes('are here')) continue // location observations

        // Share WITHOUT mutation (per user request)
        const newEntry: KnowledgeEntry = {
          id: uuid(),
          content: toShare.content,
          source: `heard from ${speaker.name}`,
          confidence: Math.max(0.2, toShare.confidence - 0.1),
          importance: Math.max(0.2, toShare.importance - 0.1),
          turnLearned: world.currentTick,
          isSecret: false,
        }

        addNpcKnowledge(listenerId, [newEntry])
        shares.push({
          fromNpcId: speakerId,
          toNpcId: listenerId,
          summary: toShare.content,
        })
      }
    }
  }

  return shares
}
