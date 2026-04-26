import { Router } from 'express'
import type { ApiResponse, ChatRequest, ChatResponse } from '../../shared/types.js'
import { conversate } from '../llm/npc-agent.js'
import {
  getWorld,
  getPlayer,
  getNpc,
  addConversationTurn,
  updateNpcMood,
  addNpcKnowledge,
  isGameActive,
  persistGame,
} from '../game/state.js'
import { v4 as uuid } from 'uuid'
import { broadcastEvent } from './events.js'

export const chatRoutes = Router()

chatRoutes.post('/', async (req, res) => {
  try {
    if (!isGameActive()) {
      res.json({ success: false, error: 'No active game' } satisfies ApiResponse<never>)
      return
    }

    const { npcId, message } = req.body as ChatRequest

    if (!npcId) {
      res.json({ success: false, error: 'npcId is required' } satisfies ApiResponse<never>)
      return
    }

    if (!message?.trim()) {
      res.json({ success: false, error: 'Message cannot be empty' } satisfies ApiResponse<never>)
      return
    }

    const npc = getNpc(npcId)

    if (!npc) {
      res.json({ success: false, error: 'NPC not found' } satisfies ApiResponse<never>)
      return
    }

    const world = getWorld()
    const player = getPlayer()

    // NPC must be at the player's location
    if (npc.currentLocationId !== player.currentLocationId) {
      res.json({ success: false, error: 'That person is not here' } satisfies ApiResponse<never>)
      return
    }

    // Mark NPC as known
    if (!player.knownNpcIds.includes(npcId)) {
      player.knownNpcIds.push(npcId)
    }

    // Save player turn
    addConversationTurn(npcId, {
      role: 'player',
      content: message,
      tick: world.currentTick,
    })

    // Get NPC response from LLM
    const history = player.conversationHistory[npcId] ?? []
    const npcResponse = await conversate(npc, world, history, message)

    // Save NPC turn
    addConversationTurn(npcId, {
      role: 'npc',
      content: npcResponse.dialogue,
      tick: world.currentTick,
    })

    // Apply state changes
    let npcMoodChanged = false
    let newKnowledgeLearned = false
    let actionTriggered = false

    if (npcResponse.mood_change) {
      updateNpcMood(
        npcId,
        npcResponse.mood_change.current,
        npcResponse.mood_change.toward_player_delta,
        npcResponse.mood_change.reason
      )
      npcMoodChanged = true
    }

    if (npcResponse.new_knowledge && npcResponse.new_knowledge.length > 0) {
      const entries = npcResponse.new_knowledge.map((k) => ({
        id: uuid(),
        content: k.content,
        source: k.source,
        confidence: 0.9,
        turnLearned: world.currentTick,
        isSecret: false,
      }))
      addNpcKnowledge(npcId, entries)
      newKnowledgeLearned = true
    }

    if (npcResponse.action_after) {
      actionTriggered = true
      broadcastEvent({
        type: 'npc_action',
        data: { npcId, description: npcResponse.action_after },
      })
    }

    // Auto-persist after conversation
    persistGame()

    const response: ApiResponse<ChatResponse> = {
      success: true,
      data: {
        dialogue: npcResponse.dialogue,
        narration: npcResponse.action_after
          ? `${npc.name} seems to have something on their mind...`
          : null,
        stateChanges: { npcMoodChanged, newKnowledgeLearned, actionTriggered },
      },
    }
    res.json(response)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    res.status(500).json({ success: false, error: message } satisfies ApiResponse<never>)
  }
})
