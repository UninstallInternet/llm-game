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
