# Automated Playtest Methodology

This script is designed for Claude to follow step-by-step when playtesting the game. Each phase tests specific systems and has explicit pass/fail criteria. Run top to bottom, fixing issues as they appear before moving to the next phase.

## Setup

1. Restart server: `pkill -f "tsx.*server"; pkill -f "vite"; sleep 2; npm run dev &`
2. Wait 4s, verify health: `curl localhost:3001/api/health`
3. Generate world with 5 NPCs, 5 locations, interesting setting
4. Record all NPC names, locations, secret goals, relationships

---

## Phase 1: First Contact (Ticks 0-2)

### 1.1 Navigate & Chat
- Move to a location with 2+ NPCs
- Chat with NPC #1: introduce yourself, ask about the town
- **CHECK**: NPC responds in character (matches personality/occupation)
- **CHECK**: NPC gains knowledge entry about the visitor
- **CHECK**: Internal thought is captured in debug
- **CHECK**: No raw JSON or plan step text in dialogue

### 1.2 Make an Agreement
- Chat with NPC #1: propose working together on something related to their public goal
- Push until they agree (2-3 messages)
- **CHECK**: Agreement appears in NPC's agreements list (inspect panel or API)
- **CHECK**: NPC replans within 1 tick — new plan should reference the agreement
- **CHECK**: Server log shows `[Agreement→Replan]`
- **CHECK**: New plan includes steps for BOTH their secret goal AND the agreement

### 1.3 Group Invite
- Say "invite [NPC #2 name]"
- **CHECK**: Response says "[Name] joins your group"
- Say something to the group (e.g. "what do you both think about [topic]?")
- **CHECK**: Response contains multi-party dialogue (both NPCs speak)
- **CHECK**: NPCs reference each other's statements (not independent reactions)

### 1.4 Group Travel
- Say "go to [other location name]"
- **CHECK**: Both player AND group NPC(s) moved to new location
- **CHECK**: Response mentions traveling together
- Say "leave the group" or "stop"
- **CHECK**: Session ends, NPCs freed (can act autonomously again)

---

## Phase 2: Autonomous Simulation (Ticks 2-15)

### 2.1 Run 20 Actions
- Send 20 "wait quietly" actions
- After each batch of 10, inspect ALL NPCs

### 2.2 Per-NPC Checklist (check EVERY NPC)
- **PLAN EXISTS**: Every NPC should have an active plan or be forming one
- **PLAN PROGRESSING**: At least 1 step should be completed per NPC by tick 10
- **NO STUCK STEPS**: No step should have "attempt 3" or higher
- **KNOWLEDGE GROWING**: Each NPC should have 5+ knowledge entries by tick 5, 10+ by tick 10
- **NO SELF-REFERENTIAL K**: Knowledge shouldn't start with the NPC's own first name (from conversations)
- **NO TRIVIAL WITNESS K**: No "The visitor wait/explore/investigate" entries
- **NO PERSPECTIVE CONTAMINATION**: No "heard from X" entries containing "is my rival/friend"
- **CONVERSATIONS HAPPENING**: At least 2 NPC-NPC conversations should have occurred (check knowledge sources containing "conversation")
- **CONVERSATIONS UNIQUE**: No two conversation knowledge entries should have the same first 40 chars

### 2.3 Conversation Quality
- Read the actual conversation knowledge entries
- **CHECK**: Topics relate to NPC goals/secrets, not generic philosophy
- **CHECK**: NPCs with plan steps targeting each other actually had conversations
- **CHECK**: Conversation reason was injected (check server log for `[Convo Reason]`)

---

## Phase 3: Plan Lifecycle (Ticks 15-30)

### 3.1 Run 30 More Actions (total ~50)

### 3.2 Plan Completion & Replanning
- **CHECK**: At least 1 NPC has completed a plan and started a new one
- **CHECK**: Completed plans have goal text that matches the NPC's secret goal
- **CHECK**: New plans after completion don't repeat already-completed steps (e.g. don't re-search the same container)
- **CHECK**: Failed plans (3+ failed steps) are abandoned, not completed

### 3.3 NPC Movement
- **CHECK**: NPCs have moved between locations (not all stuck at starting positions)
- **CHECK**: NPCs with plan steps mentioning locations actually traveled there
- **CHECK**: NPCs with plan steps targeting other NPCs auto-traveled to find them

### 3.4 Items & Discovery
- **CHECK**: At least 2 NPCs have found items (search or discovery)
- **CHECK**: Items are in NPC inventories (inspect panel)
- **CHECK**: Item discovery created knowledge entries
- **CHECK**: No NPC has "Successfully I will..." or raw plan text in knowledge

---

## Phase 4: State Tags & Physical Effects (Manual)

### 4.1 Apply Tags
- Chat with an NPC, tell them to do something that creates a tag (e.g. "sit down", "take off your coat")
- **CHECK**: State flag appears on NPC
- Run a few ticks
- **CHECK**: Other NPCs in conversations mention the visible tag (check conversation knowledge for tag-related words)

### 4.2 Combat/Physical
- Take an aggressive action toward an NPC (e.g. "punch [NPC]")
- **CHECK**: Game Master adjudicates with probability band
- **CHECK**: Health changes applied
- **CHECK**: Witnesses gain knowledge of the action
- **CHECK**: Target NPC gains knowledge and relationship changes

---

## Phase 5: Economy & Shops (if shops exist in world)

### 5.1 Shop Interaction
- Navigate to a location with a shop container
- "buy [item name]"
- **CHECK**: Item added to inventory, currency deducted
- **CHECK**: "Not enough currency" if player is broke

### 5.2 Currency Display
- **CHECK**: Player currency shown in status bar (frontend)
- **CHECK**: NPCs have varying currency amounts (inspect panel)

---

## Phase 6: Extended Stability (Ticks 30-100+)

### 6.1 Run 100+ More Actions

### 6.2 Stability Checks
- **NO CRASHES**: Server still responding
- **NO MEMORY EXPLOSION**: No NPC has 150+ knowledge entries (dedup should prevent)
- **PLANS CYCLING**: NPCs have completed multiple plans (not stuck on plan #1)
- **VARIED LOCATIONS**: NPCs are spread across locations, not all clumped
- **RELATIONSHIP CHANGES**: Trust/affection values have changed from initial
- **AGREEMENTS COMPLETING**: Some agreements should be marked inactive (completed)

### 6.3 Knowledge Quality at Scale
- Sample 3 NPCs, read their last 10 knowledge entries
- **CHECK**: Entries are specific and plot-relevant, not generic
- **CHECK**: No duplicate entries (same content, different IDs)
- **CHECK**: Sources are varied (conversation, observed, heard from, discovered)
- **CHECK**: Importance values vary (not all 0.7)

### 6.4 Narrative Coherence
- Pick 1 NPC and trace their story through knowledge timeline
- **CHECK**: Events follow logical order
- **CHECK**: NPC remembers outcomes of their own actions
- **CHECK**: Relationships reflect what happened (e.g. if they fought, trust decreased)

---

## Phase 7: Portraits (if ENABLE_PORTRAITS=true)

### 7.1 Generation
- **CHECK**: `public/portraits/` contains PNG files for each NPC
- **CHECK**: Files are valid images (>10KB each)

### 7.2 Display
- **CHECK**: NPC cards in sidebar show portrait images
- **CHECK**: Images load without 404 errors (check browser console)

---

## Issue Severity Guide

**CRITICAL** (fix immediately):
- Server crashes
- Plans never forming/executing
- NPCs not responding to chat
- Data corruption (knowledge/plans disappearing)

**HIGH** (fix before next phase):
- Plans stuck forever
- Conversations all identical/repetitive
- Knowledge entries contain raw JSON or plan step text
- Trivial/noise entries flooding knowledge

**MEDIUM** (fix during cleanup):
- Self-referential knowledge (NPC learns about themselves)
- Perspective contamination in info-share
- Tags not affecting conversations
- Currency not changing

**LOW** (note for later):
- Minor phrasing issues in knowledge
- Conversations slightly generic but not repetitive
- Portraits not pixel-art style enough

---

## Reporting Format

After each phase, output:
```
Phase X: [PASS/FAIL]
- Issues found: [count]
- Critical: [list]
- High: [list]  
- Fixed: [list]
- Remaining: [list]
```

At the end, output a final summary with all issues found and fixed.
