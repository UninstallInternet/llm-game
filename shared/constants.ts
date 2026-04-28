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
export const MAX_KNOWLEDGE_PER_NPC = 150
export const KNOWLEDGE_RELEVANCE_WINDOW = 20

export const LLM_MODELS = {
  worldGen: 'gpt-4o',
  conversation: 'gpt-4.1-mini',
  simulation: 'gpt-4.1-mini',
} as const

export const MAX_CONVERSATION_HISTORY = 20
export const MAX_SIMULATION_LLM_CALLS_PER_TICK = 8

// ─── NPC Conversation Config ───
export const MAX_NPC_CONVERSATIONS_PER_TICK = 3
export const MIN_CONVERSATION_SCORE = 0.15
export const MEMORY_DECAY_RATE = 0.95 // per tick

// ─── Memory Retrieval Weights (Stanford formula) ───
export const MEMORY_WEIGHT_IMPORTANCE = 2.0
export const MEMORY_WEIGHT_RECENCY = 0.5
export const TOP_K_MEMORIES = 30
export const MEMORY_WEIGHT_RELEVANCE = 3.0

// ─── NPC Autonomy Config ───
export const ACTIVATION_THRESHOLD_LOW = 0.15
export const ACTIVATION_THRESHOLD_HIGH = 0.35
export const MAX_PLAN_STEPS = 8
export const SEARCH_BASE_SUCCESS_RATE = 0.6
export const SEARCH_SKILL_BONUS = 0.2
export const SEARCH_COOLDOWN_TICKS = 6
export const SEARCH_DIMINISH_FACTOR = 0.7
export const MAX_GROUP_SIZE = 5

// ─── Tag Effects ───
export const TAG_EFFECTS: Record<string, {
  description: string
  visible: boolean
  probabilityModifiers?: { precision?: number; intimidation?: number; stealth?: number; social?: number }
}> = {
  drunk: { description: 'slurred speech, reduced coordination, more honest and impulsive', visible: true, probabilityModifiers: { precision: -20, social: -10 } },
  injured: { description: 'in visible pain, limited movement, weakened', visible: true, probabilityModifiers: { precision: -15, intimidation: -10 } },
  bleeding: { description: 'actively losing blood, urgent medical need', visible: true, probabilityModifiers: { precision: -25 } },
  hiding: { description: 'trying not to be noticed, avoids drawing attention', visible: false, probabilityModifiers: { stealth: 15 } },
  armed: { description: 'visibly carrying a weapon, more threatening', visible: true, probabilityModifiers: { intimidation: 15 } },
  restrained: { description: 'cannot move freely, needs to be freed', visible: true },
  disguised: { description: 'appearance altered, harder to identify', visible: true, probabilityModifiers: { stealth: 10 } },
  scared: { description: 'visibly frightened, may act erratically', visible: true, probabilityModifiers: { social: -15 } },
  angry: { description: 'visibly furious, confrontational', visible: true, probabilityModifiers: { intimidation: 10, social: -10 } },
  handstanding: { description: 'doing a handstand, very unusual', visible: true },
  sitting: { description: 'seated, relaxed posture', visible: true },
  nude: { description: 'not wearing clothes, very exposed and vulnerable', visible: true, probabilityModifiers: { social: -20, intimidation: -15 } },
  sleeping: { description: 'asleep, unaware of surroundings', visible: true, probabilityModifiers: { precision: -50, stealth: -30 } },
  wet: { description: 'soaking wet, possibly cold', visible: true },
  tied_up: { description: 'bound with rope or similar, unable to use hands', visible: true, probabilityModifiers: { precision: -40 } },
  unconscious: { description: 'knocked out, completely unresponsive', visible: true },
  undressed: { description: 'not wearing clothes', visible: true },
  // Emotional/behavioral states from conversations
  excited: { description: 'visibly energized, enthusiastic, eager to act', visible: true, probabilityModifiers: { social: 5 } },
  distressed: { description: 'visibly upset, on the verge of tears, fragile', visible: true, probabilityModifiers: { social: -10 } },
  confident: { description: 'standing tall, self-assured, decisive', visible: true, probabilityModifiers: { intimidation: 5, social: 5 } },
  suspicious: { description: 'watching others closely, guarded, untrusting', visible: true },
  aroused: { description: 'flushed, distracted by attraction', visible: true, probabilityModifiers: { precision: -10 } },
  depressed: { description: 'withdrawn, low energy, apathetic', visible: true, probabilityModifiers: { social: -15 } },
  furious: { description: 'rage-filled, barely containing violence', visible: true, probabilityModifiers: { intimidation: 20, precision: -10 } },
  panicked: { description: 'in full panic, irrational, may flee', visible: true, probabilityModifiers: { precision: -20, stealth: -15 } },
  focused: { description: 'intensely concentrated, hard to distract', visible: false, probabilityModifiers: { precision: 10 } },
  grieving: { description: 'mourning a loss, emotionally vulnerable', visible: true, probabilityModifiers: { social: -10 } },
  determined: { description: 'set on a course of action, unwavering', visible: true, probabilityModifiers: { precision: 5 } },
}

// Tags that prevent an NPC from moving or acting autonomously
export const IMMOBILIZING_TAGS = new Set([
  'restrained', 'tied_up', 'sleeping', 'unconscious',
])
