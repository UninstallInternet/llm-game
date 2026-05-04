# Contributing to The Unnamed Town

Thanks for your interest! This is an open-ended project — the core simulation engine is working, but there's a lot of surface area to build on. Contributions can come from many angles: systems design, prompt engineering, frontend, world-building, or just playtesting and filing good bug reports.

## Getting Started

1. **Fork** the repository
2. **Clone** your fork locally
3. **Create a branch**: `git checkout -b feat/my-feature`
4. **Install dependencies**: `npm install`
5. **Set up environment**: `cp .env.example .env` — add your OpenAI API key
6. **Run the dev server**: `npm run dev`
7. **Test your changes**: `npm run test:smoke` (free, no API key needed)
8. **Submit a PR** against `main`

## Before Submitting

- [ ] Compiles without errors (`npm run typecheck`)
- [ ] Smoke tests pass (`npm run test:smoke`)
- [ ] Feature has been playtested in a running game
- [ ] Commit messages follow conventional format (`feat:`, `fix:`, `refactor:`, etc.)

---

## What We Need Help With

The project is organized around a few open problem areas. Pick whatever matches your interest — these aren't siloed, and the best contributions will cut across multiple areas.

### Items & Object Interaction

Items exist in the world but aren't fully alive yet. There's huge room to expand here:

- **Item framework** — right now items are mostly passive inventory entries. We need a proper item action system: NPCs and players should be able to *use* items in meaningful ways that affect the world (a lockpick opens a door, a poison vial can be added to a drink, a letter can be read and passed on)
- **Item coherence** — items generated during world creation or discovered during play should fit the setting, the location, and the scenario. A blacksmith's shop should have believable stock; a cellar should hide things appropriate to what's going on there. Better prompting and world-context injection would help a lot
- **Item-driven planning** — NPCs should form plans around items they know about or want. "Steal the merchant's ledger" should result in a plan that actually targets that specific item, not a generic search step
- **Containers and hidden state** — the container system exists but needs richer logic: locked containers, hidden compartments, containers that only certain NPCs know about
- **Item economy** — items should have consistent value relative to the world's economy. Trades and shops feel arbitrary right now

### Group Behaviors & Collective Action

NPCs can already have multi-party conversations and group sessions with the player, but group *behavior* is underdeveloped:

- **Faction coordination** — NPCs in the same faction should be able to coordinate plans, share resources, and act collectively toward a shared goal without each one reinventing the wheel independently
- **Group travel** — a band of NPCs traveling together to a location, with emergent conversation along the way
- **Crowd dynamics** — what happens when 6+ NPCs are in the same location? Right now it mostly just means more individual conversations. There should be emergent group dynamics: someone gives a speech, a fight breaks out and draws an audience, a rumor spreads through a crowd
- **Collaborative tasks** — two NPCs working on the same task together (building something, running a heist, defending a location) rather than each executing their own separate plan

### NPC Depth & Coherence

The simulation works but NPCs can feel thin over long play sessions:

- **Long-term memory consolidation** — NPCs consolidate memories periodically, but the summaries can lose important nuance. Better consolidation prompts, or a tiered memory structure (episodic vs. semantic), would help NPCs feel like they actually remember their history
- **Personality expression** — personality traits are stored but don't consistently shape how NPCs speak, plan, or react. A cowardly NPC should flee more; a greedy one should prioritize currency; a loyal one should protect their faction even when it costs them
- **Emotional arcs** — NPCs can be `angry` or `scared` as tags, but there's no mechanism for an emotional state to evolve over time (grief that slowly becomes resolve, a grudge that festers into a plan for revenge)
- **Relationship dynamics** — trust/affection/respect/fear scores change but the NPC doesn't always *act* on them in obvious ways. A deeply distrustful relationship should produce visible avoidance, warnings to others, or active sabotage

### World Generation & Scenarios

The world generator produces good skeletons but the content can feel generic:

- **World presets** — curated settings that produce reliably interesting play (a locked-room mystery, a heist in progress, a town under occupation, a succession crisis). These live in `server/llm/world-generator.ts` and `server/llm/prompts.ts`
- **Scenario coherence** — generated worlds should feel internally consistent: factions should have real conflicts baked in, NPCs should already be mid-drama when the player arrives, mysteries should have seeded clues that actually point somewhere
- **Dynamic world events** — the event trigger system (`server/simulation/events.ts`) exists but is simple. Events should cascade: a murder triggers an investigation, which puts NPCs under pressure, which causes alliances to shift

### Frontend & UX

The UI is functional but rough in places:

- **NPC relationship graph** — visualizing the web of trust/fear/affection between NPCs would help players understand the social landscape at a glance
- **Item inspection** — clicking an item in inventory or on the ground should show its history, tags, and possible uses
- **Timeline / history view** — a scrollable log of significant world events with timestamps, so players can reconstruct what happened while they weren't watching
- **Mobile layout** — the three-column layout breaks on small screens
- **Accessibility** — keyboard navigation, screen reader support, contrast improvements

### Prompt Engineering

The LLM calls are the heart of the game. Small prompt improvements have outsized effects:

- **Conversation quality** — NPC dialogue can get repetitive in long sessions. Better derepetition, stronger personality injection, and clearer conversation goals would help
- **Plan realism** — generated plans sometimes include steps that are logically fine but narratively weird ("search the tavern for a sword" when the NPC is a blacksmith who could just make one). Better world-context in the planning prompt would help
- **Judge calibration** — the Game Master probability bands are hand-tuned. Systematic playtesting of edge cases (unarmed vs. armored, skilled vs. unskilled) and adjusting the prompt would make outcomes feel fairer
- **Structured output reliability** — even with function calling, some LLM responses include hallucinated fields or miss required ones. Better schema descriptions and few-shot examples in prompts would tighten this

### Infrastructure & Testing

- **GitHub Actions CI** — typecheck + smoke tests on every PR (see `npm run test:smoke`)
- **Deterministic test world** — a seeded world state for integration tests so results are reproducible without burning API credits every time
- **Tick profiling** — each simulation tick can involve 10–20 LLM calls. A profiler that shows which calls are slowest and how often they're triggered would help prioritize optimization
- **Cost tracking** — expose a running token/cost counter in the UI so players know what they're spending in real time

---

## Architecture Overview

| Area | Files | What it does |
|------|-------|--------------|
| NPC Planning | `server/simulation/npc-planner.ts` | Activation gating, plan formation, step execution |
| Conversations | `server/simulation/npc-conversations.ts` | NPC pairing, multi-round dialogue, outcomes |
| Action Resolution | `server/routes/action.ts`, `server/llm/judge.ts` | Game Master, probability, physical effects |
| State | `server/game/state.ts` | All mutations — knowledge, relationships, inventory, tags |
| Prompts | `server/llm/prompts.ts` | Every LLM prompt in one place |
| Types | `shared/types.ts`, `shared/constants.ts` | All types and tunable config |
| World Gen | `server/llm/world-generator.ts` | Two-phase world generation |
| Simulation Engine | `server/simulation/engine.ts` | Tick orchestration |

## Code Style

- TypeScript strict mode throughout
- Immutable state updates — always spread, never mutate directly
- All state changes go through `server/game/state.ts` — don't mutate world objects in place
- Functional patterns over classes
- Keep files under 800 lines — extract when things get large

## Questions?

Open an issue or start a discussion. Happy to help you find a good entry point.
