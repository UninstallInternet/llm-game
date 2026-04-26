import OpenAI from 'openai'
import { LLM_MODELS } from '../../shared/constants.js'

const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
  throw new Error('OPENAI_API_KEY not configured. Set it in .env')
}

const openai = new OpenAI({ apiKey, timeout: 30000 })

export type ModelTier = 'worldGen' | 'conversation' | 'simulation'

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`LLM call timed out after ${ms}ms (${label})`)), ms)
    ),
  ])
}

export async function llmCall(
  tier: ModelTier,
  systemPrompt: string,
  userMessage: string,
  jsonMode = false
): Promise<string> {
  const model = LLM_MODELS[tier]
  const timeoutMs = tier === 'worldGen' ? 120000 : 25000

  const response = await withTimeout(
    openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: tier === 'worldGen' ? 0.9 : 0.8,
      max_tokens: tier === 'worldGen' ? 16384 : 2048,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
    timeoutMs,
    tier
  )

  return response.choices[0]?.message?.content ?? ''
}

export async function llmChatCall(
  tier: ModelTier,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  jsonMode = false
): Promise<string> {
  const model = LLM_MODELS[tier]

  const response = await withTimeout(
    openai.chat.completions.create({
      model,
      messages,
      temperature: 0.8,
      max_tokens: 2048,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
    25000,
    tier
  )

  return response.choices[0]?.message?.content ?? ''
}
