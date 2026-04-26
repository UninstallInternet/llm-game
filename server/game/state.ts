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
import { TIME_ORDER, MAX_CONVERSATION_HISTORY } from '../../shared/constants.js'
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

  const updated: NPC = {
    ...npc,
    knowledge: [...npc.knowledge, ...entries],
  }
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
