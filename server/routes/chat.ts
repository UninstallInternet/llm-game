import { Router } from 'express'
import type { ApiResponse, ChatRequest, ChatResponse } from '../../shared/types.js'
import { conversate } from '../llm/npc-agent.js'
import { onPlayerAction } from '../simulation/engine.js'
import {
  getWorld,
  getPlayer,
  getNpc,
  addConversationTurn,
  updateNpcMood,
  addNpcKnowledge,
  isGameActive,
  persistGame,
  markNpcBusy,
  markNpcFree,
  updateNpcStateFlags,
  addNpcAgreement,
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

    // Mark NPC as known and busy (talking to player)
    if (!player.knownNpcIds.includes(npcId)) {
      player.knownNpcIds.push(npcId)
    }
    markNpcBusy(npcId)

    // Save player turn
    addConversationTurn(npcId, {
      role: 'player',
      content: message,
      tick: world.currentTick,
    })

    // Re-fetch NPC to get latest state (knowledge from this tick's simulation)
    const freshNpc = getNpc(npcId) ?? npc
    const history = player.conversationHistory[npcId] ?? []
    const npcResponse = await conversate(freshNpc, world, history, message)

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
        importance: Math.max(0.1, Math.min(1.0, k.importance ?? 0.5)),
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

    // Apply state changes
    if (npcResponse.state_changes && npcResponse.state_changes.length > 0) {
      updateNpcStateFlags(npcId, npcResponse.state_changes)
    }

    // Record agreement
    if (npcResponse.new_agreement) {
      addNpcAgreement(npcId, 'player', npcResponse.new_agreement, world.currentTick)
    }

    // Advance simulation and persist
    onPlayerAction()
    persistGame()

    const response: ApiResponse<ChatResponse> = {
      success: true,
      data: {
        dialogue: npcResponse.dialogue,
        narration: npcResponse.action_after
          ? `${npc.name} seems to have something on their mind...`
          : null,
        stateChanges: { npcMoodChanged, newKnowledgeLearned, actionTriggered },
        debug: {
          internalThought: npcResponse.internal_thought,
          moodChange: npcResponse.mood_change
            ? { current: npcResponse.mood_change.current, delta: npcResponse.mood_change.toward_player_delta, reason: npcResponse.mood_change.reason }
            : null,
          knowledgeGained: npcResponse.new_knowledge,
          actionAfter: npcResponse.action_after,
          wantsToEnd: npcResponse.wants_to_end_conversation,
        },
      },
    }
    res.json(response)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    res.status(500).json({ success: false, error: message } satisfies ApiResponse<never>)
  }
})

chatRoutes.post('/end', (req, res) => {
  const { npcId } = req.body as { npcId: string }
  if (npcId) {
    markNpcFree(npcId)
  }
  res.json({ success: true })
})
