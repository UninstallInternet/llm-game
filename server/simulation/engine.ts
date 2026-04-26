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
import { TICK_INTERVAL_MS } from '../../shared/constants.js'

let tickInterval: ReturnType<typeof setInterval> | null = null
let tickCount = 0

export function startSimulation(): void {
  if (tickInterval) return

  console.log('Simulation started')
  tickInterval = setInterval(() => {
    if (!isGameActive()) return
    runTick()
  }, TICK_INTERVAL_MS)
}

export function stopSimulation(): void {
  if (tickInterval) {
    clearInterval(tickInterval)
    tickInterval = null
    console.log('Simulation stopped')
  }
}

function runTick(): void {
  try {
    const world = getWorld()
    tickCount++

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
    broadcastEvent({
      type: 'simulation_tick',
      data: { tick: world.currentTick, time: newTime },
    })

    // Auto-save every 4 ticks (1 full day cycle)
    if (tickCount % 4 === 0) {
      persistGame()
    }
  } catch (error) {
    console.error('Simulation tick error:', error)
  }
}
