import { v4 as uuid } from 'uuid'
import type {
  WorldState,
  Player,
  NPC,
  Location,
  ConversationTurn,
  GameTime,
  KnowledgeEntry,
} from '../../shared/types.js'
import {
  TIME_ORDER,
  MAX_CONVERSATION_HISTORY,
  MAX_KNOWLEDGE_PER_NPC,
  MEMORY_DECAY_RATE,
  MEMORY_WEIGHT_IMPORTANCE,
  MEMORY_WEIGHT_RECENCY,
  TOP_K_MEMORIES,
} from '../../shared/constants.js'
import { saveGame, loadGame, saveConversationTurn } from '../db/database.js'

let currentWorld: WorldState | null = null
let currentPlayer: Player | null = null
let saveId: string = uuid()

export function getWorld(): WorldState {
  if (!currentWorld) throw new Error('No world loaded')
  return currentWorld
}

export function getPlayer(): Player {
  if (!currentPlayer) throw new Error('No player loaded')
  return currentPlayer
}

export function getSaveId(): string {
  return saveId
}

export function isGameActive(): boolean {
  return currentWorld !== null && currentPlayer !== null
}

export function setWorldAndPlayer(world: WorldState, player: Player): void {
  currentWorld = world
  currentPlayer = player
  saveId = world.id
}

export function getNpc(npcId: string): NPC | undefined {
  return currentWorld?.npcs.find((n) => n.id === npcId)
}

export function getLocation(locationId: string): Location | undefined {
  return currentWorld?.locations.find((l) => l.id === locationId)
}

export function getNpcsAtLocation(locationId: string): NPC[] {
  return currentWorld?.npcs.filter((n) => n.currentLocationId === locationId) ?? []
}

export function movePlayer(locationId: string): Location | null {
  if (!currentWorld || !currentPlayer) return null
  const location = getLocation(locationId)
  if (!location) return null

  currentPlayer.currentLocationId = locationId
  if (!currentPlayer.knownLocationIds.includes(locationId)) {
    currentPlayer.knownLocationIds.push(locationId)
  }

  // Mark NPCs at this location as known
  const npcsHere = getNpcsAtLocation(locationId)
  for (const npc of npcsHere) {
    if (!currentPlayer.knownNpcIds.includes(npc.id)) {
      currentPlayer.knownNpcIds.push(npc.id)
    }
  }

  return location
}

export function addConversationTurn(npcId: string, turn: ConversationTurn): void {
  if (!currentPlayer) return

  if (!currentPlayer.conversationHistory[npcId]) {
    currentPlayer.conversationHistory[npcId] = []
  }

  currentPlayer.conversationHistory[npcId].push(turn)

  // Trim to max history
  if (currentPlayer.conversationHistory[npcId].length > MAX_CONVERSATION_HISTORY) {
    currentPlayer.conversationHistory[npcId] = currentPlayer.conversationHistory[npcId].slice(
      -MAX_CONVERSATION_HISTORY
    )
  }

  saveConversationTurn(saveId, npcId, turn)
}

export function updateNpcMood(npcId: string, mood: string, playerDelta: number, reason: string): void {
  if (!currentWorld) return
  const npc = getNpc(npcId)
  if (!npc) return

  const updated: NPC = {
    ...npc,
    mood: {
      current: mood,
      toward_player: Math.max(-100, Math.min(100, npc.mood.toward_player + playerDelta)),
      reasons: [...npc.mood.reasons.slice(-4), reason],
    },
  }
  currentWorld.npcs = currentWorld.npcs.map((n) => (n.id === npcId ? updated : n))
}

export function addNpcKnowledge(npcId: string, entries: KnowledgeEntry[]): void {
  if (!currentWorld) return
  const npc = getNpc(npcId)
  if (!npc) return

  let knowledge = [...npc.knowledge, ...entries]

  // Trim to max — drop oldest low-importance entries
  if (knowledge.length > MAX_KNOWLEDGE_PER_NPC) {
    knowledge.sort((a, b) => {
      const scoreA = a.importance * Math.pow(MEMORY_DECAY_RATE, (currentWorld!.currentTick - a.turnLearned))
      const scoreB = b.importance * Math.pow(MEMORY_DECAY_RATE, (currentWorld!.currentTick - b.turnLearned))
      return scoreB - scoreA
    })
    knowledge = knowledge.slice(0, MAX_KNOWLEDGE_PER_NPC)
  }

  const updated: NPC = { ...npc, knowledge }
  currentWorld.npcs = currentWorld.npcs.map((n) => (n.id === npcId ? updated : n))
}

export function moveNpc(npcId: string, locationId: string): void {
  if (!currentWorld) return
  currentWorld.npcs = currentWorld.npcs.map((n) =>
    n.id === npcId ? { ...n, currentLocationId: locationId } : n
  )
}

export function advanceTime(): GameTime {
  if (!currentWorld) throw new Error('No world loaded')

  const currentIdx = TIME_ORDER.indexOf(currentWorld.time.timeOfDay)
  const nextIdx = (currentIdx + 1) % TIME_ORDER.length
  const newDay = nextIdx === 0 ? currentWorld.time.day + 1 : currentWorld.time.day

  currentWorld = {
    ...currentWorld,
    currentTick: currentWorld.currentTick + 1,
    time: {
      day: newDay,
      timeOfDay: TIME_ORDER[nextIdx],
    },
  }

  return currentWorld.time
}

export function persistGame(): void {
  if (!currentWorld || !currentPlayer) return
  saveGame(saveId, currentWorld.name, currentWorld, currentPlayer)
}

export function loadSavedGame(id: string): boolean {
  const saved = loadGame(id)
  if (!saved) return false
  currentWorld = saved.world
  currentPlayer = saved.player
  saveId = id
  return true
}

export function updateNpcMoodGeneral(npcId: string, mood: string, reason: string): void {
  if (!currentWorld) return
  const npc = getNpc(npcId)
  if (!npc) return

  const updated: NPC = {
    ...npc,
    mood: {
      ...npc.mood,
      current: mood,
      reasons: [...npc.mood.reasons.slice(-4), reason],
    },
  }
  currentWorld.npcs = currentWorld.npcs.map((n) => (n.id === npcId ? updated : n))
}

export function updateNpcRelationship(
  npcId: string,
  targetNpcId: string,
  deltas: { trust?: number; affection?: number; respect?: number; fear?: number },
  memory?: string
): void {
  if (!currentWorld) return
  const npc = getNpc(npcId)
  if (!npc) return

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
  const existing = npc.relationships.find((r) => r.targetNpcId === targetNpcId)

  let updatedRelationships: typeof npc.relationships
  if (existing) {
    updatedRelationships = npc.relationships.map((r) =>
      r.targetNpcId === targetNpcId
        ? {
            ...r,
            trust: clamp(r.trust + (deltas.trust ?? 0), -100, 100),
            affection: clamp(r.affection + (deltas.affection ?? 0), -100, 100),
            respect: clamp(r.respect + (deltas.respect ?? 0), -100, 100),
            fear: clamp(r.fear + (deltas.fear ?? 0), 0, 100),
            significantMemories: memory
              ? [...r.significantMemories.slice(-4), memory]
              : r.significantMemories,
          }
        : r
    )
  } else {
    const target = getNpc(targetNpcId)
    updatedRelationships = [
      ...npc.relationships,
      {
        targetNpcId,
        type: 'acquaintance' as const,
        trust: clamp(deltas.trust ?? 0, -100, 100),
        affection: clamp(deltas.affection ?? 0, -100, 100),
        respect: clamp(deltas.respect ?? 0, -100, 100),
        fear: clamp(deltas.fear ?? 0, 0, 100),
        significantMemories: memory ? [memory] : [`Met ${target?.name ?? 'someone'}`],
      },
    ]
  }

  const updated: NPC = { ...npc, relationships: updatedRelationships }
  currentWorld.npcs = currentWorld.npcs.map((n) => (n.id === npcId ? updated : n))
}

export function getTopMemories(npc: NPC, currentTick: number): KnowledgeEntry[] {
  return [...npc.knowledge]
    .map((k) => ({
      entry: k,
      score:
        k.importance * MEMORY_WEIGHT_IMPORTANCE +
        Math.pow(MEMORY_DECAY_RATE, currentTick - k.turnLearned) * MEMORY_WEIGHT_RECENCY,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K_MEMORIES)
    .map((s) => s.entry)
}
