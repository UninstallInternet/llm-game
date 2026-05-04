import { getWorld, markEventResolved } from '../game/state.js'
import type { WorldEvent } from '../../shared/types.js'

export function checkEventTriggers(): WorldEvent[] {
  const world = getWorld()
  const triggered: WorldEvent[] = []

  for (let i = 0; i < world.events.length; i++) {
    const event = world.events[i]
    if (event.resolved) continue

    const shouldTrigger =
      world.time.day >= event.triggerDay &&
      (world.time.day > event.triggerDay || world.time.timeOfDay === event.triggerTime)

    if (shouldTrigger) {
      markEventResolved(i)
      triggered.push(event)
    }
  }

  return triggered
}
