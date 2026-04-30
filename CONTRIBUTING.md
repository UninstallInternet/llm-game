# Contributing to The Unnamed Town

Thanks for your interest in contributing! This project is an LLM-powered text adventure with autonomous NPCs, and we welcome contributions of all kinds.

## Getting Started

1. **Fork** the repository
2. **Clone** your fork locally
3. **Create a branch** for your feature or fix: `git checkout -b feat/my-feature`
4. **Install dependencies**: `npm install`
5. **Set up environment**: `cp .env.example .env` and add your OpenAI API key
6. **Run the dev server**: `npm run dev`
7. **Make your changes** and test them
8. **Submit a PR** against `main`

## Before Submitting

- [ ] Code compiles without errors (`npx tsc --noEmit`)
- [ ] No console.log statements in production code
- [ ] New features have been playtested
- [ ] Commit messages follow conventional format (`feat:`, `fix:`, `refactor:`, etc.)

## What We Need Help With

- **Prompt engineering** - Improving NPC conversation quality, plan formation, and action resolution
- **Frontend UX** - Group activity interfaces, shop UI, NPC interaction improvements
- **New world presets** - Interesting scenarios and settings for world generation
- **Testing** - Integration tests, edge case identification, long-run stability
- **Performance** - Reducing LLM call latency, optimizing tick throughput
- **Documentation** - Guides, tutorials, architecture deep-dives

## Architecture Overview

See [README.md](README.md) for the full architecture breakdown. Key files:

| Area | Files |
|------|-------|
| NPC Planning | `server/simulation/npc-planner.ts` |
| Conversations | `server/simulation/npc-conversations.ts` |
| Action Resolution | `server/routes/action.ts`, `server/llm/judge.ts` |
| Prompts | `server/llm/prompts.ts` |
| State Management | `server/game/state.ts` |
| Types | `shared/types.ts`, `shared/constants.ts` |

## Code Style

- TypeScript strict mode
- Immutable state updates (never mutate, always spread)
- Functional patterns over classes
- Keep files under 800 lines

## Questions?

Open an issue or start a discussion. We're happy to help you get started.
