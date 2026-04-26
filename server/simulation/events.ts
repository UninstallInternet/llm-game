import { getWorld } from '../game/state.js'
import type { WorldEvent } from '../../shared/types.js'

export function checkEventTriggers(): WorldEvent[] {
  const world = getWorld()
  const triggered: WorldEvent[] = []

  for (const event of world.events) {
    if (event.resolved) continue

    const shouldTrigger =
      world.time.day >= event.triggerDay &&
      (world.time.day > event.triggerDay || world.time.timeOfDay === event.triggerTime)

    if (shouldTrigger) {
      event.resolved = true
      triggered.push(event)
    }
  }

  return triggered
}
