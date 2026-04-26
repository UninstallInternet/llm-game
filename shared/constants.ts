import type { TimeOfDay } from './types.js'

export const TICK_INTERVAL_MS = 30_000 // 30 seconds real time = 1 time period

export const TIME_ORDER: TimeOfDay[] = ['morning', 'afternoon', 'evening', 'night']

export const DEFAULT_NPC_COUNT = 25
export const DEFAULT_LOCATION_COUNT = 12

export const NPC_DISPOSITION_THRESHOLDS = {
  hostile: -60,
  unfriendly: -20,
  neutral: 20,
  friendly: 60,
  trusted: 80,
} as const

export const INFO_SHARE_PROBABILITY = 0.3 // chance NPCs share info when co-located
export const MAX_KNOWLEDGE_PER_NPC = 50
export const KNOWLEDGE_RELEVANCE_WINDOW = 20 // ticks

export const LLM_MODELS = {
  worldGen: 'gpt-4o-mini',
  conversation: 'gpt-4o-mini',
  simulation: 'gpt-4o-mini',
} as const

export const MAX_CONVERSATION_HISTORY = 20 // turns kept per NPC
export const MAX_SIMULATION_LLM_CALLS_PER_TICK = 3
