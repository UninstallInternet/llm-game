import { useCallback } from 'react'
import { useGameStore } from '../stores/gameStore.js'
import type { ApiResponse, ChatResponse } from '../../shared/types.js'

export function useChat() {
  const setChatLoading = useGameStore((s) => s.setChatLoading)
  const addConversationTurn = useGameStore((s) => s.addConversationTurn)
  const world = useGameStore((s) => s.world)

  const sendMessage = useCallback(
    async (npcId: string, message: string): Promise<ChatResponse | null> => {
      setChatLoading(true)
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ npcId, message }),
        })
        const json = (await res.json()) as ApiResponse<ChatResponse>

        if (!json.success || !json.data) {
          throw new Error(json.error ?? 'Chat failed')
        }

        addConversationTurn(npcId, {
          role: 'player',
          content: message,
          tick: world?.currentTick ?? 0,
        })

        addConversationTurn(npcId, {
          role: 'npc',
          content: json.data.dialogue,
          tick: world?.currentTick ?? 0,
        })

        // Store debug reasoning
        if (json.data.debug) {
          const npc = world?.npcs.find((n) => n.id === npcId)
          useGameStore.getState().setLastChatDebug({
            ...json.data.debug,
            npcName: npc?.name ?? 'Unknown',
          })
          useGameStore.getState().addDebugEntry({
            tick: world?.currentTick ?? 0,
            timestamp: Date.now(),
            type: 'player_chat',
            npcName: npc?.name ?? 'Unknown',
            data: json.data.debug as unknown as Record<string, unknown>,
          })
        }

        // Refresh full game state to pick up NPC mood/knowledge changes
        try {
          const stateRes = await fetch('/api/game/state')
          const stateJson = (await stateRes.json()) as ApiResponse<{ world: import('../../shared/types.js').WorldState; player: import('../../shared/types.js').Player }>
          if (stateJson.success && stateJson.data) {
            const store = useGameStore.getState()
            store.setGameState(stateJson.data.world, stateJson.data.player)
            // Re-set currentNpc from updated world data
            const updatedNpc = stateJson.data.world.npcs.find((n) => n.id === npcId)
            if (updatedNpc) store.setCurrentNpc(updatedNpc)
          }
        } catch { /* non-critical */ }

        return json.data
      } catch (error) {
        console.error('Chat error:', error)
        return null
      } finally {
        setChatLoading(false)
      }
    },
    [setChatLoading, addConversationTurn, world]
  )

  return { sendMessage }
}
