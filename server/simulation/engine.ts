import {
  getWorld,
  isGameActive,
  advanceTime,
  persistGame,
} from '../game/state.js'
import { broadcastEvent } from '../routes/events.js'
import { moveNpcsToSchedule } from './npc-behavior.js'
import { propagateInfo } from './info-share.js'
import { checkEventTriggers } from './events.js'
import { runNpcConversations } from './npc-conversations.js'

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
    // 1. Advance time
    const newTime = advanceTime()
    broadcastEvent({ type: 'time_advanced', data: newTime })

    // 2. Move NPCs according to schedules
    const movements = moveNpcsToSchedule()
    for (const move of movements) {
      broadcastEvent({ type: 'npc_moved', data: move })
    }

    // 3. Silent info propagation
    const shares = propagateInfo()
    for (const share of shares) {
      broadcastEvent({ type: 'info_shared', data: share })
    }

    // 4. NPC-to-NPC conversations (async, 1-2 LLM calls)
    await runNpcConversations()

    // 5. Check for event triggers
    const triggered = checkEventTriggers()
    for (const event of triggered) {
      broadcastEvent({ type: 'event_triggered', data: event })
    }

    // 6. Broadcast tick
    const world = getWorld()
    broadcastEvent({
      type: 'simulation_tick',
      data: { tick: world.currentTick, time: newTime },
    })

    // Auto-save every full day
    if (world.currentTick % 4 === 0) {
      persistGame()
    }
  } catch (error) {
    console.error('Simulation tick error:', error)
  } finally {
    tickInProgress = false
  }
}
