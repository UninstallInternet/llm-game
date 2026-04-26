import { create } from 'zustand'
import type {
  WorldState,
  Player,
  NPC,
  GameEvent,
  ConversationTurn,
} from '../../shared/types.js'

interface GameStore {
  // State
  world: WorldState | null
  player: Player | null
  isLoading: boolean
  isGenerating: boolean
  generationMessages: string[]
  currentNpc: NPC | null
  chatLoading: boolean
  eventLog: Array<{ timestamp: number; message: string }>

  // Actions
  setGameState: (world: WorldState, player: Player) => void
  setLoading: (loading: boolean) => void
  setGenerating: (generating: boolean) => void
  addGenerationMessage: (message: string) => void
  clearGenerationMessages: () => void
  setCurrentNpc: (npc: NPC | null) => void
  setChatLoading: (loading: boolean) => void
  addEventLog: (message: string) => void
  movePlayerTo: (locationId: string, npcsHere: NPC[]) => void
  addConversationTurn: (npcId: string, turn: ConversationTurn) => void
  updateNpcInWorld: (npcId: string, updates: Partial<NPC>) => void
  handleGameEvent: (event: GameEvent) => void
}

export const useGameStore = create<GameStore>((set, get) => ({
  world: null,
  player: null,
  isLoading: false,
  isGenerating: false,
  generationMessages: [],
  currentNpc: null,
  chatLoading: false,
  eventLog: [],

  setGameState: (world, player) => set({ world, player, isGenerating: false }),

  setLoading: (isLoading) => set({ isLoading }),

  setGenerating: (isGenerating) => set({ isGenerating }),

  addGenerationMessage: (message) =>
    set((state) => ({
      generationMessages: [...state.generationMessages, message],
    })),

  clearGenerationMessages: () => set({ generationMessages: [] }),

  setCurrentNpc: (currentNpc) => set({ currentNpc }),

  setChatLoading: (chatLoading) => set({ chatLoading }),

  addEventLog: (message) =>
    set((state) => ({
      eventLog: [...state.eventLog.slice(-50), { timestamp: Date.now(), message }],
    })),

  movePlayerTo: (locationId, npcsHere) =>
    set((state) => {
      if (!state.player) return state
      const knownNpcIds = [...state.player.knownNpcIds]
      for (const npc of npcsHere) {
        if (!knownNpcIds.includes(npc.id)) knownNpcIds.push(npc.id)
      }
      return {
        player: {
          ...state.player,
          currentLocationId: locationId,
          knownNpcIds,
          knownLocationIds: state.player.knownLocationIds.includes(locationId)
            ? state.player.knownLocationIds
            : [...state.player.knownLocationIds, locationId],
        },
      }
    }),

  addConversationTurn: (npcId, turn) =>
    set((state) => {
      if (!state.player) return state
      const history = { ...state.player.conversationHistory }
      history[npcId] = [...(history[npcId] ?? []), turn]
      return { player: { ...state.player, conversationHistory: history } }
    }),

  updateNpcInWorld: (npcId, updates) =>
    set((state) => {
      if (!state.world) return state
      return {
        world: {
          ...state.world,
          npcs: state.world.npcs.map((n) => (n.id === npcId ? { ...n, ...updates } : n)),
        },
      }
    }),

  handleGameEvent: (event) => {
    const state = get()
    switch (event.type) {
      case 'time_advanced':
        if (state.world) {
          set({
            world: { ...state.world, time: event.data, currentTick: state.world.currentTick + 1 },
          })
          state.addEventLog(`Time: Day ${event.data.day}, ${event.data.timeOfDay}`)
        }
        break
      case 'npc_moved': {
        const npc = state.world?.npcs.find((n) => n.id === event.data.npcId)
        if (npc) {
          state.updateNpcInWorld(event.data.npcId, { currentLocationId: event.data.toLocationId })
          const toLoc = state.world?.locations.find((l) => l.id === event.data.toLocationId)
          if (toLoc && event.data.toLocationId === state.player?.currentLocationId) {
            state.addEventLog(`${npc.name} arrives.`)
          }
          if (event.data.fromLocationId === state.player?.currentLocationId) {
            state.addEventLog(`${npc.name} leaves.`)
          }
        }
        break
      }
      case 'event_triggered':
        state.addEventLog(`[Event] ${event.data.title}: ${event.data.description}`)
        break
      case 'info_shared': {
        const from = state.world?.npcs.find((n) => n.id === event.data.fromNpcId)
        const to = state.world?.npcs.find((n) => n.id === event.data.toNpcId)
        if (
          from &&
          to &&
          (from.currentLocationId === state.player?.currentLocationId ||
            to.currentLocationId === state.player?.currentLocationId)
        ) {
          state.addEventLog(`You overhear ${from.name} telling ${to.name} something.`)
        }
        break
      }
      case 'npc_conversation': {
        const convData = event.data as { npc1Id: string; npc2Id: string; locationId: string; summary: string }
        const cn1 = state.world?.npcs.find((n) => n.id === convData.npc1Id)
        const cn2 = state.world?.npcs.find((n) => n.id === convData.npc2Id)
        if (cn1 && cn2 && convData.locationId === state.player?.currentLocationId) {
          state.addEventLog(`${cn1.name} and ${cn2.name} are talking. ${convData.summary}`)
        }
        break
      }
      case 'npc_action': {
        const actingNpc = state.world?.npcs.find((n) => n.id === event.data.npcId)
        if (actingNpc) {
          state.addEventLog(`${actingNpc.name}: ${event.data.description}`)
        }
        break
      }
      case 'world_generated':
        state.addGenerationMessage(event.data.message)
        break
      default:
        break
    }
  },
}))
