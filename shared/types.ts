// ─── Core Game Types ───

export interface Relationship {
  targetNpcId: string
  type: 'friend' | 'rival' | 'spouse' | 'family' | 'employer' | 'employee' | 'acquaintance' | 'enemy'
  strength: number // -100 to 100
  notes: string
}

export interface KnowledgeEntry {
  id: string
  content: string
  source: string // "witnessed" | "heard from X" | "rumor"
  confidence: number // 0.0 to 1.0
  turnLearned: number
  isSecret: boolean
}

export interface ScheduleEntry {
  timeSlot: TimeOfDay
  locationId: string
  activity: string
}

export interface NPCPersonality {
  traits: string[]
  speechStyle: string
  quirk: string
}

export interface NPC {
  id: string
  name: string
  age: number
  occupation: string
  personality: NPCPersonality
  appearance: string
  goals: {
    public: string
    secret: string
  }
  secrets: string[]
  relationships: Relationship[]
  knowledge: KnowledgeEntry[]
  mood: {
    current: string
    toward_player: number // -100 to 100
    reasons: string[]
  }
  schedule: ScheduleEntry[]
  currentLocationId: string
  factionId: string | null
}

export interface Location {
  id: string
  name: string
  type: string
  description: string
  connections: string[] // IDs of connected locations
  isPublic: boolean
  ownerId: string | null
}

export interface Faction {
  id: string
  name: string
  description: string
  publicGoal: string
  secretGoal: string
  memberNpcIds: string[]
}

export interface Clue {
  id: string
  content: string
  foundByPlayer: boolean
  locationId: string | null
  npcId: string | null
}

export interface Mystery {
  id: string
  name: string
  description: string // what the player knows so far
  clues: Clue[]
  resolution: string // hidden truth
  isResolved: boolean
}

export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'night'

export interface GameTime {
  day: number
  timeOfDay: TimeOfDay
}

export interface WorldEvent {
  id: string
  type: 'crisis' | 'opportunity' | 'discovery' | 'conflict' | 'social'
  title: string
  description: string
  triggerDay: number
  triggerTime: TimeOfDay
  resolved: boolean
  involvedNpcIds: string[]
  consequences: string[]
}

export interface WorldState {
  id: string
  name: string
  settingDescription: string
  currentTick: number
  time: GameTime
  locations: Location[]
  npcs: NPC[]
  factions: Faction[]
  events: WorldEvent[]
  mysteries: Mystery[]
}

export interface Player {
  currentLocationId: string
  knownNpcIds: string[]
  knownLocationIds: string[]
  notes: string[]
  conversationHistory: Record<string, ConversationTurn[]>
}

export interface ConversationTurn {
  role: 'player' | 'npc'
  content: string
  tick: number
}

// ─── LLM Response Types ───

export interface NPCResponse {
  dialogue: string
  internal_thought: string
  mood_change: {
    current: string
    toward_player_delta: number
    reason: string
  } | null
  new_knowledge: Array<{ content: string; source: string }> | null
  wants_to_end_conversation: boolean
  action_after: string | null
}

export interface SimulationAction {
  npcId: string
  activity: string
  location_change: string | null
  share_info: { targetNpcId: string; content: string } | null
  mood_shift: { new_mood: string; reason: string } | null
  trigger_event: { type: string; description: string } | null
}

// ─── API Types ───

export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

export interface ChatRequest {
  npcId: string
  message: string
}

export interface ChatResponse {
  dialogue: string
  narration: string | null
  stateChanges: {
    npcMoodChanged: boolean
    newKnowledgeLearned: boolean
    actionTriggered: boolean
  }
}

export interface GenerateWorldRequest {
  settingDescription: string
  npcCount: number
  locationCount: number
}

export interface GameStateResponse {
  world: WorldState
  player: Player
}

// ─── SSE Event Types ───

export type GameEvent =
  | { type: 'time_advanced'; data: GameTime }
  | { type: 'npc_moved'; data: { npcId: string; fromLocationId: string; toLocationId: string } }
  | { type: 'event_triggered'; data: WorldEvent }
  | { type: 'info_shared'; data: { fromNpcId: string; toNpcId: string; summary: string } }
  | { type: 'npc_action'; data: { npcId: string; description: string } }
  | { type: 'world_generated'; data: { phase: string; message: string } }
  | { type: 'simulation_tick'; data: { tick: number; time: GameTime } }
