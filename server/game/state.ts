import { v4 as uuid } from 'uuid'
import type {
  WorldState,
  Player,
  NPC,
  Location,
  ConversationTurn,
  GameTime,
  KnowledgeEntry,
  TimeOfDay,
} from '../../shared/types.js'
import {
  TIME_ORDER,
  MAX_CONVERSATION_HISTORY,
  MAX_KNOWLEDGE_PER_NPC,
  MEMORY_DECAY_RATE,
  MEMORY_WEIGHT_IMPORTANCE,
  MEMORY_WEIGHT_RECENCY,
  MEMORY_WEIGHT_RELEVANCE,
  TOP_K_MEMORIES,
} from '../../shared/constants.js'
import { saveGame, loadGame, saveConversationTurn } from '../db/database.js'

let currentWorld: WorldState | null = null
let currentPlayer: Player | null = null
let saveId: string = uuid()

// Track NPCs currently "busy" (talking to player or in NPC-to-NPC conversation)
const busyNpcIds = new Set<string>()

export function markNpcBusy(npcId: string): void {
  busyNpcIds.add(npcId)
}

export function markNpcFree(npcId: string): void {
  busyNpcIds.delete(npcId)
}

export function isNpcBusy(npcId: string): boolean {
  return busyNpcIds.has(npcId)
}

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

function migratePlayer(player: Partial<Player>): Player {
  return {
    currentLocationId: player.currentLocationId ?? '',
    knownNpcIds: player.knownNpcIds ?? [],
    knownLocationIds: player.knownLocationIds ?? [],
    notes: player.notes ?? [],
    conversationHistory: player.conversationHistory ?? {},
    inventory: player.inventory ?? [],
    physical: player.physical ?? { health: 100, energy: 100, injuries: [], status: 'alive' as const },
    actionLog: player.actionLog ?? [],
  }
}

function migrateNpc(npc: Partial<NPC>): NPC {
  return {
    ...npc,
    occupationTags: npc.occupationTags ?? ['general-knowledge'],
    beliefs: npc.beliefs ?? [],
    inventory: npc.inventory ?? [],
    activePlan: npc.activePlan ?? null,
    physical: npc.physical ?? { health: 100, energy: 100, injuries: [], status: 'alive' as const },
    stateFlags: npc.stateFlags ?? [],
    agreements: npc.agreements ?? [],
    knowledge: (npc.knowledge ?? []).map((k) => ({
      ...k,
      importance: k.importance ?? 0.5,
    })),
    relationships: (npc.relationships ?? []).map((r) => ({
      ...r,
      trust: r.trust ?? (r as { strength?: number }).strength ?? 0,
      affection: r.affection ?? 0,
      respect: r.respect ?? 0,
      fear: r.fear ?? 0,
      significantMemories: r.significantMemories ?? [],
    })),
  } as NPC
}

function migrateWorld(world: Partial<WorldState>): WorldState {
  return {
    ...world,
    npcs: (world.npcs ?? []).map(migrateNpc),
    locations: (world.locations ?? []).map((l) => ({
      ...l,
      tags: l.tags ?? [l.type ?? 'other'],
      securityLevel: l.securityLevel ?? 0,
      containers: (l.containers ?? []).map((c) => ({
        ...c,
        searchCount: (c as unknown as { searchCount?: number; searched?: boolean }).searchCount ??
          ((c as unknown as { searched?: boolean }).searched ? 1 : 0),
        lastSearchTick: (c as unknown as { lastSearchTick?: number }).lastSearchTick ?? 0,
      } as import('../../shared/types.js').LocationContainer)),
      fixtures: l.fixtures ?? [],
      items: l.items ?? [],
    })),
  } as WorldState
}

export function setWorldAndPlayer(world: WorldState, player: Player): void {
  currentWorld = migrateWorld(world)
  currentPlayer = migratePlayer(player)
  saveId = currentWorld.id
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

function memorySimilar(a: string, b: string): boolean {
  const aLower = a.toLowerCase()
  const bLower = b.toLowerCase()
  if (aLower === bLower) return true

  // Check if first 40 chars match (likely same topic, just updated)
  if (aLower.slice(0, 40) === bLower.slice(0, 40)) return true

  // Check keyword overlap — if 60%+ of significant words match, it's similar
  const wordsA = new Set(aLower.split(/\s+/).filter((w) => w.length > 4))
  const wordsB = new Set(bLower.split(/\s+/).filter((w) => w.length > 4))
  if (wordsA.size === 0 || wordsB.size === 0) return false
  const overlap = [...wordsA].filter((w) => wordsB.has(w)).length
  const similarity = overlap / Math.min(wordsA.size, wordsB.size)
  return similarity > 0.6
}

export function addNpcKnowledge(npcId: string, entries: KnowledgeEntry[]): void {
  if (!currentWorld) return
  const npc = getNpc(npcId)
  if (!npc) return

  let knowledge = [...npc.knowledge]

  for (const entry of entries) {
    // Check for similar existing knowledge — update instead of duplicate
    const existingIdx = knowledge.findIndex((k) => memorySimilar(k.content, entry.content))
    if (existingIdx !== -1) {
      const existing = knowledge[existingIdx]
      // Keep the newer, more detailed version
      if (entry.content.length >= existing.content.length) {
        knowledge[existingIdx] = {
          ...entry,
          importance: Math.max(existing.importance, entry.importance),
          confidence: Math.max(existing.confidence, entry.confidence),
        }
      } else {
        // Just bump importance and tick
        knowledge[existingIdx] = {
          ...existing,
          importance: Math.max(existing.importance, entry.importance),
          turnLearned: entry.turnLearned,
        }
      }
    } else {
      knowledge.push(entry)
    }
  }

  // Trim to max — drop lowest-scored entries
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

function hourToTimeOfDay(hour: number): TimeOfDay {
  if (hour >= 6 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 17) return 'afternoon'
  if (hour >= 17 && hour < 22) return 'evening'
  return 'night'
}

export function advanceTime(): GameTime {
  if (!currentWorld) throw new Error('No world loaded')

  // Advance by 10 minutes per tick
  let hour = currentWorld.time.hour ?? 8
  let minute = (currentWorld.time.minute ?? 0) + 10
  let day = currentWorld.time.day

  if (minute >= 60) {
    minute = minute - 60
    hour++
  }
  if (hour >= 24) {
    hour = 0
    day++
  }

  currentWorld = {
    ...currentWorld,
    currentTick: currentWorld.currentTick + 1,
    time: {
      day,
      timeOfDay: hourToTimeOfDay(hour),
      hour,
      minute,
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
  currentWorld = migrateWorld(saved.world)
  currentPlayer = migratePlayer(saved.player)
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

export function getTopMemories(npc: NPC, currentTick: number, context?: string): KnowledgeEntry[] {
  // Extract keywords from context for relevance scoring
  const contextWords = context
    ? new Set(context.toLowerCase().split(/\s+/).filter((w) => w.length > 3))
    : null

  return [...npc.knowledge]
    .map((k) => {
      const recency = Math.pow(MEMORY_DECAY_RATE, Math.max(0, currentTick - k.turnLearned))
      const importance = k.importance ?? 0.5

      // Relevance: keyword overlap between memory content and context
      let relevance = 0
      if (contextWords && contextWords.size > 0) {
        const memWords = k.content.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
        const overlap = memWords.filter((w) => contextWords.has(w)).length
        relevance = Math.min(1, overlap / 3) // normalize: 3+ shared words = max relevance
      }

      const score =
        importance * MEMORY_WEIGHT_IMPORTANCE +
        recency * MEMORY_WEIGHT_RECENCY +
        relevance * MEMORY_WEIGHT_RELEVANCE

      return { entry: k, score }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K_MEMORIES)
    .map((s) => s.entry)
}

export function updateNpcStateFlags(npcId: string, changes: string[]): void {
  if (!currentWorld) return
  const npc = getNpc(npcId)
  if (!npc) return

  const flags = new Set(npc.stateFlags ?? [])
  for (const change of changes) {
    if (change.startsWith('add:')) flags.add(change.slice(4))
    else if (change.startsWith('remove:')) flags.delete(change.slice(7))
    else flags.add(change) // default to add
  }

  const updated: NPC = { ...npc, stateFlags: [...flags] }
  currentWorld.npcs = currentWorld.npcs.map((n) => (n.id === npcId ? updated : n))
}

export function addNpcAgreement(
  npcId: string,
  withId: string,
  content: string,
  tick: number
): void {
  if (!currentWorld) return
  const npc = getNpc(npcId)
  if (!npc) return

  // Dedup: if same withId + similar content exists, update instead of duplicating
  const contentWords = new Set(content.toLowerCase().split(/\s+/).filter((w) => w.length > 3))
  const existing = (npc.agreements ?? []).find(
    (a) => {
      if (a.withId !== withId || !a.active) return false
      if (a.content.toLowerCase() === content.toLowerCase()) return true
      // Keyword overlap check
      const existingWords = a.content.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
      const overlap = existingWords.filter((w) => contentWords.has(w)).length
      return overlap >= 3 || (existingWords.length > 0 && overlap / existingWords.length > 0.5)
    }
  )
  if (existing) {
    // Update existing agreement immutably
    const updatedAgreements = (npc.agreements ?? []).map((a) =>
      a === existing
        ? { ...a, content: content.length > a.content.length ? content : a.content, madeAtTick: tick }
        : a
    )
    currentWorld.npcs = currentWorld.npcs.map((n) =>
      n.id === npcId ? { ...n, agreements: updatedAgreements } : n
    )
    return
  }

  const agreements = [...(npc.agreements ?? []), { withId, content, madeAtTick: tick, active: true }]
  // Keep only last 8 active + any inactive for history
  const active = agreements.filter((a) => a.active).slice(-8)
  const inactive = agreements.filter((a) => !a.active).slice(-4)
  const trimmed = [...inactive, ...active]

  const updated: NPC = { ...npc, agreements: trimmed }
  currentWorld.npcs = currentWorld.npcs.map((n) => (n.id === npcId ? updated : n))
}

export function updateNpcPlan(npcId: string, plan: NPC['activePlan']): void {
  if (!currentWorld) return
  currentWorld.npcs = currentWorld.npcs.map((n) =>
    n.id === npcId ? { ...n, activePlan: plan ? { ...plan } : null } : n
  )
}

export function completeAgreement(npcId: string, agreementContent: string): void {
  if (!currentWorld) return
  const npc = getNpc(npcId)
  if (!npc) return

  const agreement = (npc.agreements ?? []).find(
    (a) => a.active && a.content.toLowerCase().includes(agreementContent.toLowerCase().slice(0, 20))
  )
  if (agreement) {
    const updatedAgreements = (npc.agreements ?? []).map((a) =>
      a === agreement ? { ...a, active: false } : a
    )
    currentWorld.npcs = currentWorld.npcs.map((n) =>
      n.id === npcId ? { ...n, agreements: updatedAgreements } : n
    )
  }
}

export function transferItem(fromId: string, toId: string, itemName: string): boolean {
  if (!currentWorld) return false

  // Find item in source inventory
  const fromNpc = fromId === 'player' ? null : getNpc(fromId)
  const fromInventory = fromId === 'player'
    ? (currentPlayer?.inventory ?? [])
    : (fromNpc?.inventory ?? [])

  const itemIdx = fromInventory.findIndex((i) =>
    i.name.toLowerCase().includes(itemName.toLowerCase()) ||
    itemName.toLowerCase().includes(i.name.toLowerCase())
  )
  if (itemIdx === -1) return false

  const item = { ...fromInventory[itemIdx], ownerId: toId }
  const newFromInventory = fromInventory.filter((_, i) => i !== itemIdx)

  // Update source inventory immutably
  if (fromId === 'player' && currentPlayer) {
    currentPlayer = { ...currentPlayer, inventory: newFromInventory }
  } else if (fromNpc) {
    currentWorld.npcs = currentWorld.npcs.map((n) =>
      n.id === fromId ? { ...n, inventory: newFromInventory } : n
    )
  }

  // Add to target inventory immutably
  if (toId === 'player' && currentPlayer) {
    currentPlayer = { ...currentPlayer, inventory: [...currentPlayer.inventory, item] }
  } else {
    const toNpc = getNpc(toId)
    if (toNpc) {
      currentWorld.npcs = currentWorld.npcs.map((n) =>
        n.id === toId ? { ...n, inventory: [...n.inventory, item] } : n
      )
    }
  }

  return true
}

export function consumeItem(ownerId: string, itemName: string): boolean {
  if (!currentWorld) return false

  if (ownerId === 'player' && currentPlayer) {
    const idx = currentPlayer.inventory.findIndex((i) =>
      i.name.toLowerCase().includes(itemName.toLowerCase())
    )
    if (idx === -1) return false
    currentPlayer = { ...currentPlayer, inventory: currentPlayer.inventory.filter((_, i) => i !== idx) }
    return true
  }

  const npc = getNpc(ownerId)
  if (!npc) return false

  const idx = npc.inventory.findIndex((i) =>
    i.name.toLowerCase().includes(itemName.toLowerCase())
  )
  if (idx === -1) return false
  currentWorld.npcs = currentWorld.npcs.map((n) =>
    n.id === ownerId ? { ...n, inventory: n.inventory.filter((_, i2) => i2 !== idx) } : n
  )
  return true
}

export function dropItemAtLocation(ownerId: string, itemName: string): boolean {
  if (!currentWorld) return false

  const npc = ownerId === 'player' ? null : getNpc(ownerId)
  const inventory = ownerId === 'player'
    ? (currentPlayer?.inventory ?? [])
    : (npc?.inventory ?? [])

  const idx = inventory.findIndex((i) =>
    i.name.toLowerCase().includes(itemName.toLowerCase())
  )
  if (idx === -1) return false

  const item = { ...inventory[idx], locationId: '', ownerId: null as string | null }
  const newInventory = inventory.filter((_, i) => i !== idx)
  const locationId = ownerId === 'player'
    ? currentPlayer?.currentLocationId
    : npc?.currentLocationId

  // Update owner inventory immutably
  if (ownerId === 'player' && currentPlayer) {
    currentPlayer = { ...currentPlayer, inventory: newInventory }
  } else if (npc) {
    currentWorld.npcs = currentWorld.npcs.map((n) =>
      n.id === ownerId ? { ...n, inventory: newInventory } : n
    )
  }

  if (locationId) {
    item.locationId = locationId
    const loc = currentWorld.locations.find((l) => l.id === locationId)
    if (loc) {
      loc.items = [...loc.items, item]
    }
  }

  return true
}

export function applyPhysicalEffects(
  npcId: string,
  effects: {
    healthDelta?: number
    energyDelta?: number
    injury?: string | null
    statusChange?: NPC['physical']['status'] | null
  }
): void {
  if (!currentWorld) return
  const npc = getNpc(npcId)
  if (!npc) return

  const health = Math.max(0, Math.min(100, npc.physical.health + (effects.healthDelta ?? 0)))
  const energy = Math.max(0, Math.min(100, npc.physical.energy + (effects.energyDelta ?? 0)))
  const injuries = effects.injury
    ? [...npc.physical.injuries.slice(-4), effects.injury]
    : npc.physical.injuries

  // Determine status
  let status = effects.statusChange ?? npc.physical.status
  if (health <= 0) status = 'dead'
  else if (health <= 15 && status === 'alive') status = 'unconscious'

  const updated: NPC = {
    ...npc,
    physical: { health, energy, injuries, status },
  }
  currentWorld.npcs = currentWorld.npcs.map((n) => (n.id === npcId ? updated : n))
}
