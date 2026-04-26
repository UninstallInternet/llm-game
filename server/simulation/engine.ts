import {
  getWorld,
  isGameActive,
  advanceTime,
  persistGame,
  isNpcBusy,
} from '../game/state.js'
import { broadcastEvent } from '../routes/events.js'
import { moveNpcsToSchedule } from './npc-behavior.js'
import { propagateInfo } from './info-share.js'
import { checkEventTriggers } from './events.js'
import { runNpcConversations } from './npc-conversations.js'
import { processNpcTurn } from './npc-planner.js'
import { MAX_SIMULATION_LLM_CALLS_PER_TICK } from '../../shared/constants.js'

let actionCount = 0
let tickInProgress = false
const ACTIONS_PER_TICK = 3

export function startSimulation(): void {
  actionCount = 0
}

export function stopSimulation(): void {
  actionCount = 0
}

export function onPlayerAction(): void {
  if (!isGameActive()) return

  actionCount++

  if (actionCount >= ACTIONS_PER_TICK && !tickInProgress) {
    actionCount = 0
    void runTick()
  }
}

async function runTick(): Promise<void> {
  if (tickInProgress) return
  tickInProgress = true

  try {
    const world = getWorld()

    // 1. Advance time
    const newTime = advanceTime()
    broadcastEvent({ type: 'time_advanced', data: newTime })

    // 2. Move NPCs according to schedules (only those without active plans)
    const movements = moveNpcsToSchedule()
    for (const move of movements) {
      broadcastEvent({ type: 'npc_moved', data: move })
    }

    // 3. Silent info propagation
    const shares = propagateInfo()
    for (const share of shares) {
      broadcastEvent({ type: 'info_shared', data: share })
    }

    // 4. NPC-to-NPC conversations (1-2 LLM calls)
    await runNpcConversations()

    // 5. NPC autonomous actions — process each NPC with budget control
    let llmBudget = MAX_SIMULATION_LLM_CALLS_PER_TICK - 2 // reserve 2 for conversations
    const updatedWorld = getWorld()

    for (const npc of updatedWorld.npcs) {
      if (llmBudget <= 0) break
      if (isNpcBusy(npc.id)) continue // skip NPCs in conversation

      const result = await processNpcTurn(npc, updatedWorld)
      llmBudget -= result.llmCalls

      if (result.action !== 'routine' && result.action !== 'thinking') {
        console.log(`[NPC Turn] ${npc.name}: ${result.action}`)
      }
    }

    // 6. Check for event triggers
    const triggered = checkEventTriggers()
    for (const event of triggered) {
      broadcastEvent({ type: 'event_triggered', data: event })
    }

    // 7. Broadcast tick
    broadcastEvent({
      type: 'simulation_tick',
      data: { tick: updatedWorld.currentTick, time: newTime },
    })

    // Auto-save every full day
    if (updatedWorld.currentTick % 4 === 0) {
      persistGame()
    }
  } catch (error) {
    console.error('Simulation tick error:', error)
  } finally {
    tickInProgress = false
  }
}
