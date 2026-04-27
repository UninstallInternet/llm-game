import type { NPC, WorldState, ConversationTurn, NPCResponse } from '../../shared/types.js'
import { llmChatCall } from './client.js'
import { buildConversationMessages } from './prompts.js'

// Detect and truncate repetitive LLM output
function derepeat(text: string): string {
  if (text.length < 100) return text

  // Find repeating phrases (min 20 chars)
  for (let len = 20; len < Math.min(200, text.length / 2); len++) {
    const phrase = text.slice(0, len)
    const count = text.split(phrase).length - 1
    if (count >= 3) {
      // Found repetition — keep just the first occurrence + a bit more
      const firstEnd = text.indexOf(phrase, len)
      if (firstEnd > 0) {
        return text.slice(0, firstEnd).trim()
      }
    }
  }

  // Also catch "key": "value" , "key": "value" patterns (malformed JSON in dialogue)
  if ((text.match(/"\s*:\s*"/g) ?? []).length > 3) {
    // Extract just the quoted strings
    const quotes = text.match(/"([^"]{3,})"/g)
    if (quotes && quotes.length > 0) {
      const uniqueQuotes = [...new Set(quotes.map((q) => q.slice(1, -1)))]
      return uniqueQuotes.slice(0, 3).join(' ')
    }
  }

  return text
}

function parseNpcResponse(raw: string): NPCResponse {
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  }

  try {
    const parsed = JSON.parse(cleaned)

    // Extract dialogue — handle cases where LLM nests it oddly
    let dialogue = ''
    if (typeof parsed.dialogue === 'string') {
      dialogue = parsed.dialogue
    } else if (typeof parsed === 'object') {
      // Try to find any string that looks like dialogue
      dialogue = parsed.dialogue ?? parsed.response ?? parsed.text ?? ''
      if (typeof dialogue !== 'string') dialogue = JSON.stringify(dialogue)
    }

    // Clean up dialogue — remove any JSON-like artifacts
    dialogue = dialogue.replace(/^\s*\{.*?"dialogue"\s*:\s*"?/i, '')
    dialogue = dialogue.replace(/"?\s*,\s*"internal_thought.*$/is, '')
    dialogue = dialogue.trim()

    // Detect and fix repetition (LLM sometimes loops the same phrase)
    dialogue = derepeat(dialogue)

    if (!dialogue) dialogue = '...'

    return {
      dialogue,
      internal_thought: typeof parsed.internal_thought === 'string' ? parsed.internal_thought : '',
      mood_change: parsed.mood_change && typeof parsed.mood_change === 'object' ? parsed.mood_change : null,
      new_knowledge: Array.isArray(parsed.new_knowledge) ? parsed.new_knowledge : null,
      wants_to_end_conversation: parsed.wants_to_end_conversation ?? false,
      action_after: typeof parsed.action_after === 'string' ? parsed.action_after : null,
      state_changes: Array.isArray(parsed.state_changes) ? parsed.state_changes : null,
      new_agreement: typeof parsed.new_agreement === 'string' ? parsed.new_agreement : null,
    }
  } catch {
    // JSON parse failed entirely — extract dialogue from raw text
    // Try to find a dialogue field in the raw string
    const dialogueMatch = raw.match(/"dialogue"\s*:\s*"((?:[^"\\]|\\.)*)"/s)
    if (dialogueMatch) {
      return {
        dialogue: dialogueMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n'),
        internal_thought: '',
        mood_change: null,
        new_knowledge: null,
        wants_to_end_conversation: false,
        action_after: null,
        state_changes: null,
        new_agreement: null,
      }
    }

    let fallback = raw.trim()
    fallback = fallback.replace(/[{}[\]]/g, '').replace(/"dialogue"\s*:/gi, '').replace(/"internal_thought".*$/is, '').trim()
    if (fallback.length > 500) fallback = fallback.slice(0, 500)

    return {
      dialogue: fallback || '...',
      internal_thought: '',
      mood_change: null,
      new_knowledge: null,
      wants_to_end_conversation: false,
      action_after: null,
      state_changes: null,
      new_agreement: null,
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
