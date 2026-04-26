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

let actionCount = 0
const ACTIONS_PER_TICK = 3 // every 3 player actions = 1 time period

// Called by startSimulation/stopSimulation for compatibility, but no interval
export function startSimulation(): void {
  actionCount = 0
}

export function stopSimulation(): void {
  actionCount = 0
}

/**
 * Called after each player action (chat, move).
 * Every ACTIONS_PER_TICK actions, the world advances one time period.
 */
export function onPlayerAction(): void {
  if (!isGameActive()) return

  actionCount++

  if (actionCount >= ACTIONS_PER_TICK) {
    actionCount = 0
    runTick()
  }
}

function runTick(): void {
  try {
    // 1. Advance time
    const newTime = advanceTime()
    broadcastEvent({ type: 'time_advanced', data: newTime })

    // 2. Move NPCs according to schedules
    const movements = moveNpcsToSchedule()
    for (const move of movements) {
      broadcastEvent({ type: 'npc_moved', data: move })
    }

    // 3. Share information between co-located NPCs (no mutation)
    const shares = propagateInfo()
    for (const share of shares) {
      broadcastEvent({ type: 'info_shared', data: share })
    }

    // 4. Check for event triggers
    const triggered = checkEventTriggers()
    for (const event of triggered) {
      broadcastEvent({ type: 'event_triggered', data: event })
    }

    // 5. Broadcast tick
    const world = getWorld()
    broadcastEvent({
      type: 'simulation_tick',
      data: { tick: world.currentTick, time: newTime },
    })

    // Auto-save every full day (4 ticks)
    if (world.currentTick % 4 === 0) {
      persistGame()
    }
  } catch (error) {
    console.error('Simulation tick error:', error)
  }
}
