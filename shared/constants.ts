import type { TimeOfDay } from './types.js'

export const TICK_INTERVAL_MS = 30_000

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

export const INFO_SHARE_PROBABILITY = 0.3
export const MAX_KNOWLEDGE_PER_NPC = 50
export const KNOWLEDGE_RELEVANCE_WINDOW = 20

export const LLM_MODELS = {
  worldGen: 'gpt-4o',
  conversation: 'gpt-4o-mini',
  simulation: 'gpt-4o-mini',
} as const

export const MAX_CONVERSATION_HISTORY = 20
export const MAX_SIMULATION_LLM_CALLS_PER_TICK = 8

// ─── NPC Conversation Config ───
export const MAX_NPC_CONVERSATIONS_PER_TICK = 2
export const MIN_CONVERSATION_SCORE = 0.15
export const MEMORY_DECAY_RATE = 0.95 // per tick

// ─── Memory Retrieval Weights (Stanford formula) ───
export const MEMORY_WEIGHT_IMPORTANCE = 2.0
export const MEMORY_WEIGHT_RECENCY = 0.5
export const TOP_K_MEMORIES = 5

// ─── NPC Autonomy Config ───
export const ACTIVATION_THRESHOLD_LOW = 0.3
export const ACTIVATION_THRESHOLD_HIGH = 0.6
export const MAX_PLAN_STEPS = 8
export const SEARCH_BASE_SUCCESS_RATE = 0.6  // base chance of finding item when searching
export const SEARCH_SKILL_BONUS = 0.2        // bonus for matching occupation tags
