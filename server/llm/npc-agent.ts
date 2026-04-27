import type { NPC, WorldState, ConversationTurn, NPCResponse } from '../../shared/types.js'
import { llmFunctionCall } from './client.js'
import { NPC_RESPONSE_SCHEMA } from './schemas.js'
import { buildConversationMessages } from './prompts.js'

interface RawFunctionResponse {
  dialogue: string
  internal_thought: string
  mood_change: { current: string; toward_player_delta: number; reason: string } | null
  new_knowledge: Array<{ content: string; source: string; importance: number }>
  state_changes: string[] | null
  new_agreement: string | null
  action_after: string | null
  wants_to_end_conversation: boolean
}

function inferMissingFields(
  response: RawFunctionResponse,
  playerMessage: string,
): RawFunctionResponse {
  // Ensure new_knowledge always has at least one entry
  if (!response.new_knowledge || response.new_knowledge.length === 0) {
    response.new_knowledge = [{
      content: `The visitor said: "${playerMessage.slice(0, 100)}"`,
      source: 'visitor',
      importance: 0.3,
    }]
  }

  // Clean up dialogue — remove any JSON artifacts
  if (response.dialogue) {
    response.dialogue = response.dialogue.trim()
    if (!response.dialogue) response.dialogue = '...'
  }

  return response
}

export async function conversate(
  npc: NPC,
  world: WorldState,
  history: ConversationTurn[],
  playerMessage: string
): Promise<NPCResponse> {
  const messages = buildConversationMessages(npc, world, history, playerMessage)

  try {
    const result = await llmFunctionCall<RawFunctionResponse>(
      'conversation',
      messages,
      NPC_RESPONSE_SCHEMA
    )

    const cleaned = inferMissingFields(result, playerMessage)

    return {
      dialogue: cleaned.dialogue || '...',
      internal_thought: cleaned.internal_thought || '',
      mood_change: cleaned.mood_change || null,
      new_knowledge: cleaned.new_knowledge,
      wants_to_end_conversation: cleaned.wants_to_end_conversation ?? false,
      action_after: cleaned.action_after || null,
      state_changes: cleaned.state_changes || null,
      new_agreement: cleaned.new_agreement || null,
    }
  } catch (error) {
    console.error(`NPC conversation failed for ${npc.name}:`, error)
    // Deterministic fallback — never lose the player's message
    return {
      dialogue: '*looks at you thoughtfully* "..."',
      internal_thought: 'Something went wrong with my response.',
      mood_change: null,
      new_knowledge: [{
        content: `The visitor said: "${playerMessage.slice(0, 100)}"`,
        source: 'visitor',
        importance: 0.3,
      }],
      wants_to_end_conversation: false,
      action_after: null,
      state_changes: null,
      new_agreement: null,
    }
  }
}
