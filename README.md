# The Unnamed Town — LLM-Powered Text Adventure

An emergent text adventure where NPCs are fully autonomous agents powered by LLM. They form plans, have real conversations, make agreements, search for items, confront each other, and remember everything. The player can talk freely, take any action, and participate in group activities with multiple NPCs.

## Quick Start

```bash
npm install
cp .env.example .env  # add your OPENAI_API_KEY
npm run dev            # starts server (:3001) + frontend (:5173)
```

Open **http://localhost:5173**. Pick a preset or describe your own world. Generate. Play.

## Tech Stack

- **Frontend**: React + TypeScript + Vite + Tailwind CSS
- **Backend**: Node.js + Express
- **LLM**: OpenAI API (gpt-4o for world gen, gpt-4o-mini for everything else)
- **Database**: SQLite via better-sqlite3
- **State**: Zustand (client), in-memory + SQLite (server)

---

## Architecture Overview

**7,500+ lines across 38 TypeScript files**

```
server/
  db/database.ts          — SQLite save/load
  game/state.ts           — All state mutations, memory dedup, item transfer (634 lines)
  llm/
    client.ts             — OpenAI API wrapper with timeouts
    judge.ts              — Game Master action resolution system
    npc-agent.ts          — NPC dialogue parser with derepeat guard
    prompts.ts            — All prompt builders (575 lines)
    world-generator.ts    — Staged world generation (489 lines)
  routes/
    action.ts             — Player actions + group activity sessions (553 lines)
    chat.ts               — Player-NPC dialogue with state sync
    game.ts               — New game, save, load, auto-resume
    world.ts              — Navigation, NPC info (secrets stripped)
    events.ts             — SSE real-time event stream
  simulation/
    engine.ts             — Tick system (mini + full ticks)
    npc-planner.ts        — Autonomous planning + execution (665 lines)
    npc-conversations.ts  — N-party multi-round conversations (471 lines)
    npc-reflection.ts     — Periodic NPC self-assessment
    npc-social.ts         — Encounter strategy + belief evaluation
    npc-behavior.ts       — Schedule-based NPC movement
    info-share.ts         — Knowledge propagation between NPCs
    discovery.ts          — Content generation on objective completion
    events.ts             — Time-triggered world events

shared/
  types.ts                — All type definitions (354 lines)
  constants.ts            — Tunable configuration

src/
  components/
    chat/ChatPanel.tsx    — Talk mode + Act mode + group sessions (391 lines)
    layout/GameLayout.tsx — 3-column layout with debug toggle
    overlays/WorldGen.tsx — World creation + saved game loading
    sidebar/DebugPanel.tsx — NPC reasoning chain visualization
    sidebar/EventLog.tsx  — Real-time event feed
    sidebar/NPCList.tsx   — NPC cards with inspect panels (238 lines)
    world/WorldMap.tsx    — Force-directed SVG station map (282 lines)
    world/LocationPanel.tsx — Current location description
    world/LocationNav.tsx — Travel buttons to connected locations
  hooks/
    useChat.ts            — Chat hook with full state refresh
    useSSE.ts             — Server-sent events listener
  stores/
    gameStore.ts          — Zustand store (265 lines)
```

---

## Core Systems

### 1. World Generation (Staged)

Two-phase generation using different models for reliability:

| Phase | Model | What | Output |
|-------|-------|------|--------|
| Skeleton | gpt-4o | Locations, factions, mystery, events | Containers, fixtures, security levels |
| NPCs | gpt-4o-mini (batches of 5) | Characters with relationships | Personalities, secrets, schedules, items |

Locations have searchable containers with expected item types, security levels (0-5), fixtures, and initial loose items. NPCs get occupation-derived tags (mechanic → tool-use, scientist → lab-equipment) and starting inventory.

### 2. NPC Memory

Context-relevant retrieval inspired by Stanford's Generative Agents:

```
score = importance × 2.0 + recency × 0.5 + relevance × 3.0
```

- **30 memories** injected per prompt (top-scored from 150 stored)
- **Relevance**: keyword overlap between memory and current conversation topic
- **LLM-rated importance**: the AI decides significance (0.1 trivial → 1.0 critical)
- **Deduplication**: similar memories merge (60%+ keyword overlap)
- **Mandatory capture**: every conversation turn records what was said
- **2-3 sentence detail**: memories include names, specifics, context

### 3. NPC Autonomy

Fully autonomous agents with activation-energy gating:

```
activation < 0.3  → routine (no LLM call)
activation 0.3-0.6 → internal monologue
activation > 0.6  → plan formation + execution
```

**Planning**: LLM generates multi-step plans with a "HOW THE WORLD WORKS" context explaining item prerequisites, witness mechanics, security levels, and consequences.

**Execution**: ALL actions route through the Game Master (no fixed action list). NPCs auto-travel to target NPCs before social actions. Social steps trigger real conversations via plan-aware pairing.

**Reflection**: Every 12 ticks, NPCs assess their situation and may replan, approach the player, or form new beliefs.

### 4. Conversations

Multi-party, multi-round conversations:

- **N-party**: 2-5 NPCs per conversation, auto-grouped by plans/events/relationships
- **Multi-round**: up to 4 rounds per tick, building on prior dialogue
- **Plan context**: "IMPORTANT: Emma specifically came to talk to Rachel about the photo shoot"
- **Commitments**: agreements labeled "MUST act on" in conversation prompts
- **Prior history**: previous conversations referenced to prevent repetition
- **Real outcomes**: agreements, item transfers, conflicts — steps only complete on real outcomes

### 5. Social Intelligence

Mostly deterministic (zero LLM cost):

- **Encounter assessment**: relationship × personality → threat level
- **Strategy selection**: personality-driven (honest/recruit/lie/deflect/flee)
- **Belief evaluation**: trust × personality modifiers × knowledge consistency
- **Target reactions**: victims and witnesses gain knowledge of actions

### 6. Player Interaction

**Talk mode**: Free-form dialogue with NPC, full conversation history with session markers.

**Act mode**: Free-form actions resolved by Game Master. Any action mentioning NPCs triggers individual per-NPC reactions with full personal context.

**Group sessions**: First group action starts a persistent session. Follow-up actions stay with the same NPCs. Session ends on "leave/stop/go to/search". Full session summary stored as memory for all participants.

### 7. Dynamic NPC State

- **State flags**: open-ended tags (nude, drunk, hiding, bleeding — any string)
- **Agreements**: tracked commitments with keyword-based deduplication
- **Physical state**: health (0-100), energy, injuries, status (alive/unconscious/dead/restrained)
- **Relationships**: trust, affection, respect, fear (each -100 to +100, independent)
- **Significant memories**: key events stored per relationship

### 8. World Physics

- **Game Master**: probability bands (5-90%) based on actor tags, tools, environment
- **3-tier outcomes**: strong success / partial success / failure (with reversed effects on fail)
- **Items**: search, pick up, transfer, consume, drop — with re-search on cooldown
- **Discovery**: strong success on objectives generates new items, observations, clues
- **Witnesses**: all NPCs at player location gain knowledge of player actions

---

## UI

| Panel | Contents |
|-------|----------|
| **Left** | Current location info, force-directed SVG map, travel buttons |
| **Center** | Talk mode (amber) / Act mode (green), player status bar (HP, energy, inventory), group sessions |
| **Right** | NPC list with inspect panels, event log |
| **Debug** (toggle) | NPC reasoning chains, conversation dialogue, mood/relationship changes |

**NPC Inspect**: Click "i" next to any NPC to see: HP, inventory, state tags, agreements, active plan (steps with status), relationships (trust/affection/respect/fear), last 5 memories.

**Player Status**: Expandable bar showing HP/energy bars, injuries, inventory pills, known NPCs/locations, recent actions.

---

## Time & Simulation

- **Action-driven**: no real-time ticking — world advances when the player acts
- **10 minutes per tick**: every 2 player actions = 1 full tick
- **Full ticks**: time advances, NPC conversations, autonomous planning, reflections, event triggers
- **No mini-ticks**: simplified to full ticks only for reliability

---

## Cost Estimates (gpt-4o-mini)

| Operation | Cost |
|-----------|------|
| Player chat | ~$0.0003 |
| NPC conversation round | ~$0.0003 |
| Plan formation | ~$0.0004 |
| Group activity (3 NPCs) | ~$0.001 |
| World generation (gpt-4o) | ~$0.30 |
| **Per hour of gameplay** | **~$0.15-0.30** |

---

## Testing

```bash
# Start the server first
npm run dev:server

# Run integration tests (requires OpenAI API key, ~$0.05 per run)
npm run test
```

12 automated tests covering: world gen, chat, memory, actions, ticks, plans, navigation, save/load, agreement dedup, memory dedup.

---

## Development History (80+ commits)

### Phase 1: Foundation
Core game loop — world generation, NPC dialogue, simulation engine, SQLite persistence, React UI with 3-panel layout, action-based time system.

### Phase 2: NPC Autonomy
NPC-to-NPC conversations, autonomous planning with multi-step execution, social intelligence module, physical state system, Game Master adjudication, discovery system.

### Phase 3: Memory & State
Memory overhaul (5→30 memories, relevance scoring), dynamic state tags, agreements system, conversation consistency (session markers, voice reinforcement), staged world generation (gpt-4o + gpt-4o-mini batches).

### Phase 4: Agency Overhaul
Universal action execution (removed hardcoded switch), plan-aware conversation pairing, target NPC reactions + witnesses, NPC reflection cycle, conversation commitments → real plans, auto-travel to targets, multi-round persistent conversations.

### Phase 5: Group Interactions
N-party conversations (2-5 participants), player group activities with per-NPC LLM calls, persistent group sessions with context continuity, interactive SVG map, NPC inspect panels, comprehensive debug tooling.

### Phase 6: Reliability Refactor
OpenAI function calling on all 6 LLM call sites (guaranteed schema compliance), structured prompt sections optimized for LLM attention, deterministic fallbacks, need-driven conversations (NPCs only talk when they have a reason), impossible plan detection, auto-travel to locations in plan steps.

### Phase 7: Autonomous Simulation
Verified 113-tick autonomous simulation with 4 NPCs pursuing secret goals:
- NPCs proactively form plans from secret goals without player prompting
- Plans execute, complete, and new plans emerge automatically
- Single-round conversations that immediately produce knowledge
- 91% unique conversation topics (minimal repetition)
- Critical crash fix (null step in conversation pairing killed ticks 52-105)
- Integration test suite (19/20 passing)

### Code Quality
5 code review passes, 4 CRITICAL data corruption fixes (immutability violations), race condition prevention, memory deduplication, agreement deduplication, function calling eliminates JSON parsing failures.
