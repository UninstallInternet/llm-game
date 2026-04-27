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
  pendingApproach: { npcId: string; npcName: string; reason: string } | null
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
  pendingApproach: null,
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
        const participantNames = (d.participantIds ?? [])
          .map((id: string) => state.world?.npcs.find((n) => n.id === id)?.name ?? '?')
          .filter((n: string) => n !== '?')

        if (participantNames.length > 0 && d.locationId === state.player?.currentLocationId) {
          state.addEventLog(`${participantNames.join(', ')} are talking. ${d.summary}`)
        }

        if (participantNames.length > 0) {
          state.addDebugEntry({
            tick: state.world?.currentTick ?? 0,
            timestamp: Date.now(),
            type: 'npc_conversation',
            npcName: participantNames.join(' <-> '),
            data: {
              summary: d.summary,
              thoughts: d.thoughts ?? {},
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
      default: {
        // Handle npc_approaches (sent as untyped event)
        const anyEvent = event as { type: string; data: { npcId?: string; description?: string } }
        if (anyEvent.type === 'npc_approaches' && anyEvent.data.npcId) {
          const approachNpc = state.world?.npcs.find((n) => n.id === anyEvent.data.npcId)
          if (approachNpc && approachNpc.currentLocationId === state.player?.currentLocationId) {
            set({
              pendingApproach: {
                npcId: approachNpc.id,
                npcName: approachNpc.name,
                reason: anyEvent.data.description ?? 'wants to talk',
              },
            })
            state.addEventLog(`${approachNpc.name} approaches you.`)
          }
        }
        break
      }
    }
  },
}))
