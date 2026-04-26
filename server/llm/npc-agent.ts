import type { NPC, WorldState, ConversationTurn, NPCResponse } from '../../shared/types.js'
import { llmChatCall } from './client.js'
import { buildConversationMessages } from './prompts.js'

function parseNpcResponse(raw: string): NPCResponse {
  // Strip markdown code fences if present
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  }

  try {
    const parsed = JSON.parse(cleaned) as NPCResponse
    return {
      dialogue: parsed.dialogue || "...",
      internal_thought: parsed.internal_thought || "",
      mood_change: parsed.mood_change || null,
      new_knowledge: parsed.new_knowledge || null,
      wants_to_end_conversation: parsed.wants_to_end_conversation ?? false,
      action_after: parsed.action_after || null,
    }
  } catch {
    // If JSON parsing fails, treat the entire response as dialogue
    return {
      dialogue: raw.trim() || "...",
      internal_thought: "",
      mood_change: null,
      new_knowledge: null,
      wants_to_end_conversation: false,
      action_after: null,
    }
  }
}

export async function conversate(
  npc: NPC,
  world: WorldState,
  history: ConversationTurn[],
  playerMessage: string
): Promise<NPCResponse> {
  const messages = buildConversationMessages(npc, world, history, playerMessage)

  const rawResponse = await llmChatCall('conversation', messages, true)

  return parseNpcResponse(rawResponse)
}
