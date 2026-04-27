// ─── Core Game Types ───

export interface Relationship {
  targetNpcId: string
  type: 'friend' | 'rival' | 'spouse' | 'family' | 'employer' | 'employee' | 'acquaintance' | 'enemy'
  trust: number      // -100 to 100
  affection: number  // -100 to 100
  respect: number    // -100 to 100
  fear: number       // 0 to 100
  significantMemories: string[]
}

export interface KnowledgeEntry {
  id: string
  content: string
  source: string // "witnessed" | "heard from X" | "rumor"
  confidence: number // 0.0 to 1.0
  importance: number // 0.0 to 1.0 — how significant is this memory
  turnLearned: number
  isSecret: boolean
}

// ─── NPC Conversation Types ───

export interface NpcTakeaway {
  knowledge: string
  moodShift: string | null
  relationshipDeltas: Record<string, number>
  internalReaction: string
}

export interface NpcConversationResult {
  participantIds: string[]
  locationId: string
  tick: number
  summary: string
  dialogue: Array<{ speaker: string; says: string }>
  takeaways: Record<string, NpcTakeaway>
  outcome: {
    agreement_reached?: string | null
    item_transferred?: { from: string; to: string; item: string } | null
    conflict?: string | null
  } | null
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
  occupationTags: string[]  // ["mechanical-repair", "tool-use"]
  personality: NPCPersonality
  appearance: string
  goals: {
    public: string
    secret: string
  }
  secrets: string[]
  relationships: Relationship[]
  knowledge: KnowledgeEntry[]
  beliefs: BeliefEntry[]
  mood: {
    current: string
    toward_player: number // -100 to 100
    reasons: string[]
  }
  schedule: ScheduleEntry[]
  currentLocationId: string
  factionId: string | null
  inventory: Item[]
  activePlan: NpcPlan | null
  physical: PhysicalState
  stateFlags: string[]        // open-ended: ["handstanding", "drunk", "hiding", "bleeding"]
  agreements: Agreement[]
}

export interface Agreement {
  withId: string              // NPC ID or "player"
  content: string             // "always do a handstand when asked"
  madeAtTick: number
  active: boolean
}

export interface PhysicalState {
  health: number          // 0-100, 0 = dead
  energy: number          // 0-100, drains with actions, recovers with rest
  injuries: string[]      // ["bruised ribs", "concussion"]
  status: 'alive' | 'unconscious' | 'dead' | 'restrained'
}

// ─── Items & Containers ───

export interface Item {
  id: string
  name: string
  tags: string[]          // ["tool", "cutting", "heavy"]
  locationId: string | null
  ownerId: string | null
  description: string
}

export interface LocationContainer {
  id: string
  name: string            // "tool chest", "filing cabinet"
  tags: string[]          // ["locked", "metal"]
  searchDifficulty: number // 0-5
  searchCount: number     // how many times searched
  lastSearchTick: number  // when last searched
  expectedItemTypes: string[]
}

// ─── NPC Planning ───

export interface PlanStep {
  action: string          // open-ended: "search", "travel", "charm", "fight", "sabotage", "heal", anything
  target: string          // location ID, NPC ID, or description
  description: string
  status: 'pending' | 'active' | 'completed' | 'failed' | 'skipped'
  result?: string
}

export interface NpcPlan {
  id: string
  goal: string
  motivation: string
  steps: PlanStep[]
  allies: string[]
  status: 'forming' | 'active' | 'paused' | 'completed' | 'abandoned'
  formedAtTick: number
}

// ─── Belief Ledger ───

export interface BeliefEntry {
  proposition: string
  source: string          // NPC ID or "observed" or "inferred"
  confidence: number
  corroboratedBy: string[]
  contradictedBy: string[]
  tick: number
}

export interface Location {
  id: string
  name: string
  type: string
  description: string
  connections: string[]
  isPublic: boolean
  ownerId: string | null
  tags: string[]                    // ["indoor", "secure", "workshop"]
  securityLevel: number             // 0=open, 1=social, 2=locked, 3=keycard, 4=biometric, 5=vault
  containers: LocationContainer[]
  fixtures: string[]                // immovable features: ["control-panel", "furnace"]
  items: Item[]                     // loose items at this location
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

// ─── Action Resolution ───

export interface JudgeResult {
  probability: number     // 1-99
  reasoning: string
  outcome: 'strong_success' | 'partial_success' | 'failure'
  narrativeHint: string   // brief description of what happened
}

export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'night'

export interface GameTime {
  day: number
  timeOfDay: TimeOfDay
  hour: number     // 0-23
  minute: number   // 0-59
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
  inventory: Item[]
  physical: PhysicalState
  actionLog: Array<{ tick: number; action: string; result: string }>
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
  new_knowledge: Array<{ content: string; source: string; importance?: number }> | null
  wants_to_end_conversation: boolean
  action_after: string | null
  state_changes: string[] | null  // ["add:handstanding", "remove:sitting"]
  new_agreement: string | null    // "agreed to always do X"
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

export interface PlayerActionRequest {
  action: string // free-form: "search the tool chest", "pick up the wrench", "hide behind crates"
}

export interface PlayerActionResponse {
  outcome: 'strong_success' | 'partial_success' | 'failure'
  narrative: string
  itemFound: Item | null
  healthDelta: number
  energyDelta: number
  injury: string | null
}

export interface DebugReasoning {
  internalThought: string
  moodChange: { current: string; delta: number; reason: string } | null
  knowledgeGained: Array<{ content: string; source: string }> | null
  actionAfter: string | null
  wantsToEnd: boolean
}

export interface ChatResponse {
  dialogue: string
  narration: string | null
  stateChanges: {
    npcMoodChanged: boolean
    newKnowledgeLearned: boolean
    actionTriggered: boolean
  }
  debug: DebugReasoning | null
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
  | { type: 'npc_conversation'; data: {
      participantIds: string[]; locationId: string; summary: string
      thoughts: Record<string, string>
    } }
  | { type: 'npc_plan'; data: { npcId: string; goal: string; status: string; stepCount: number } }
  | { type: 'npc_action_result'; data: { npcId: string; action: string; outcome: string; description: string } }
  | { type: 'item_found'; data: { npcId: string; itemName: string; locationId: string } }
  | { type: 'world_generated'; data: { phase: string; message: string } }
  | { type: 'simulation_tick'; data: { tick: number; time: GameTime } }
