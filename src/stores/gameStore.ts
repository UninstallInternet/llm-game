import { create } from 'zustand'
import type {
  WorldState,
  Player,
  NPC,
  GameEvent,
  ConversationTurn,
  DebugReasoning,
} from '../../shared/types.js'

export interface DebugEntry {
  tick: number
  timestamp: number
  type: 'player_chat' | 'npc_conversation' | 'npc_action'
  npcName: string
  data: Record<string, unknown>
}

interface GameStore {
  world: WorldState | null
  player: Player | null
  isLoading: boolean
  isGenerating: boolean
  generationMessages: string[]
  currentNpc: NPC | null
  chatLoading: boolean
  eventLog: Array<{ timestamp: number; message: string }>
  debugLog: DebugEntry[]
  showDebug: boolean
  lastChatDebug: (DebugReasoning & { npcName: string }) | null

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
  toggleDebug: () => void
  addDebugEntry: (entry: DebugEntry) => void
  setLastChatDebug: (debug: (DebugReasoning & { npcName: string }) | null) => void
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
  debugLog: [],
  showDebug: false,
  lastChatDebug: null,

  setGameState: (world, player) => set({ world, player, isGenerating: false }),
  setLoading: (isLoading) => set({ isLoading }),
  setGenerating: (isGenerating) => set({ isGenerating }),
  addGenerationMessage: (message) =>
    set((state) => ({ generationMessages: [...state.generationMessages, message] })),
  clearGenerationMessages: () => set({ generationMessages: [] }),
  setCurrentNpc: (newNpc) => {
    const prev = get().currentNpc
    // Free the previous NPC from conversation
    if (prev && prev.id !== newNpc?.id) {
      fetch('/api/chat/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ npcId: prev.id }),
      }).catch(() => {})
    }
    set({ currentNpc: newNpc })
  },
  setChatLoading: (chatLoading) => set({ chatLoading }),
  toggleDebug: () => set((state) => ({ showDebug: !state.showDebug })),
  setLastChatDebug: (lastChatDebug) => set({ lastChatDebug }),

  addEventLog: (message) =>
    set((state) => ({
      eventLog: [...state.eventLog.slice(-50), { timestamp: Date.now(), message }],
    })),

  addDebugEntry: (entry) =>
    set((state) => ({
      debugLog: [...state.debugLog.slice(-30), entry],
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
          if (event.data.toLocationId === state.player?.currentLocationId) {
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
        if (from && to && (from.currentLocationId === state.player?.currentLocationId || to.currentLocationId === state.player?.currentLocationId)) {
          state.addEventLog(`You overhear ${from.name} telling ${to.name} something.`)
        }
        break
      }
      case 'npc_conversation': {
        const d = event.data
        const cn1 = state.world?.npcs.find((n) => n.id === d.npc1Id)
        const cn2 = state.world?.npcs.find((n) => n.id === d.npc2Id)
        if (cn1 && cn2) {
          if (d.locationId === state.player?.currentLocationId) {
            state.addEventLog(`${cn1.name} and ${cn2.name} are talking. ${d.summary}`)
          }
          state.addDebugEntry({
            tick: state.world?.currentTick ?? 0,
            timestamp: Date.now(),
            type: 'npc_conversation',
            npcName: `${cn1.name} <-> ${cn2.name}`,
            data: {
              summary: d.summary,
              npc1: { name: cn1.name, thought: d.npc1Thought, moodShift: d.npc1MoodShift, relDelta: d.relationshipDeltas.npc1 },
              npc2: { name: cn2.name, thought: d.npc2Thought, moodShift: d.npc2MoodShift, relDelta: d.relationshipDeltas.npc2 },
            },
          })
        }
        break
      }
      case 'npc_action': {
        const actingNpc = state.world?.npcs.find((n) => n.id === event.data.npcId)
        if (actingNpc && actingNpc.currentLocationId === state.player?.currentLocationId) {
          state.addEventLog(`${actingNpc.name}: ${event.data.description}`)
        }
        state.addDebugEntry({
          tick: state.world?.currentTick ?? 0,
          timestamp: Date.now(),
          type: 'npc_action',
          npcName: actingNpc?.name ?? 'Unknown',
          data: { description: event.data.description },
        })
        break
      }
      case 'npc_plan': {
        const planData = event.data as { npcId: string; goal: string; status: string; stepCount: number }
        const planNpc = state.world?.npcs.find((n) => n.id === planData.npcId)
        state.addDebugEntry({
          tick: state.world?.currentTick ?? 0,
          timestamp: Date.now(),
          type: 'npc_action',
          npcName: planNpc?.name ?? 'Unknown',
          data: { plan: planData.goal, status: planData.status, steps: planData.stepCount },
        })
        break
      }
      case 'npc_action_result': {
        const arData = event.data as { npcId: string; action: string; outcome: string; description: string }
        const arNpc = state.world?.npcs.find((n) => n.id === arData.npcId)
        if (arNpc && arNpc.currentLocationId === state.player?.currentLocationId) {
          state.addEventLog(`${arNpc.name} ${arData.description}`)
        }
        state.addDebugEntry({
          tick: state.world?.currentTick ?? 0,
          timestamp: Date.now(),
          type: 'npc_action',
          npcName: arNpc?.name ?? 'Unknown',
          data: { action: arData.action, outcome: arData.outcome, description: arData.description },
        })
        break
      }
      case 'item_found': {
        const ifData = event.data as { npcId: string; itemName: string; locationId: string }
        const ifNpc = state.world?.npcs.find((n) => n.id === ifData.npcId)
        if (ifNpc && ifData.locationId === state.player?.currentLocationId) {
          state.addEventLog(`${ifNpc.name} found something.`)
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
