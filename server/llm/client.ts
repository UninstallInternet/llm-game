import OpenAI from 'openai'
import { LLM_MODELS } from '../../shared/constants.js'

const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
  throw new Error('OPENAI_API_KEY not configured. Set it in .env')
}

const openai = new OpenAI({ apiKey })

export type ModelTier = 'worldGen' | 'conversation' | 'simulation'

export async function llmCall(
  tier: ModelTier,
  systemPrompt: string,
  userMessage: string,
  jsonMode = false
): Promise<string> {
  const model = LLM_MODELS[tier]

  const response = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: tier === 'worldGen' ? 0.9 : 0.8,
    max_tokens: tier === 'worldGen' ? 4096 : 2048,
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  })

  return response.choices[0]?.message?.content ?? ''
}

export async function llmChatCall(
  tier: ModelTier,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  jsonMode = false
): Promise<string> {
  const model = LLM_MODELS[tier]

  const response = await openai.chat.completions.create({
    model,
    messages,
    temperature: 0.8,
    max_tokens: 2048,
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  })

  return response.choices[0]?.message?.content ?? ''
}
