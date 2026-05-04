import OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js'
import { LLM_MODELS } from '../../shared/constants.js'

const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
  throw new Error('OPENAI_API_KEY not configured. Set it in .env')
}
if (apiKey === 'your-openai-api-key-here') {
  throw new Error('OPENAI_API_KEY is still the placeholder value. Set a real key in .env')
}

const openai = new OpenAI({ apiKey, timeout: 120000 })

export type ModelTier = 'worldGen' | 'conversation' | 'simulation'

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`LLM call timed out after ${ms}ms (${label})`)), ms)
    ),
  ])
}

// ─── Raw text/JSON calls (kept for world gen + legacy) ───

export async function llmCall(
  tier: ModelTier,
  systemPrompt: string,
  userMessage: string,
  jsonMode = false
): Promise<string> {
  const model = LLM_MODELS[tier]
  const timeoutMs = tier === 'worldGen' ? 120000 : 60000

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
    60000,
    tier
  )

  return response.choices[0]?.message?.content ?? ''
}

// ─── Function calling — guaranteed schema compliance ───

export interface FunctionSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export async function llmFunctionCall<T = Record<string, unknown>>(
  tier: ModelTier,
  messages: ChatCompletionMessageParam[],
  schema: FunctionSchema
): Promise<T> {
  const model = LLM_MODELS[tier]

  const response = await withTimeout(
    openai.chat.completions.create({
      model,
      messages,
      temperature: 0.8,
      max_tokens: 2048,
      tools: [{
        type: 'function',
        function: {
          name: schema.name,
          description: schema.description,
          parameters: schema.parameters,
        },
      }],
      tool_choice: { type: 'function', function: { name: schema.name } },
    }),
    60000,
    tier
  )

  const toolCall = response.choices[0]?.message?.tool_calls?.[0]
  if (!toolCall) {
    throw new Error('No function call in response')
  }

  // Extract arguments from the tool call (handle different SDK versions)
  const args = (toolCall as unknown as { function?: { arguments?: string } }).function?.arguments
    ?? (toolCall as unknown as { arguments?: string }).arguments

  if (!args) {
    throw new Error('No arguments in function call')
  }

  return JSON.parse(args) as T
}
