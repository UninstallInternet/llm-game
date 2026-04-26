import { getWorld, moveNpc } from '../game/state.js'
import type { TimeOfDay } from '../../shared/types.js'

interface NpcMovement {
  npcId: string
  fromLocationId: string
  toLocationId: string
}

export function moveNpcsToSchedule(): NpcMovement[] {
  const world = getWorld()
  const currentTime = world.time.timeOfDay
  const movements: NpcMovement[] = []

  for (const npc of world.npcs) {
    // Skip NPCs with active plans — they manage their own movement
    if (npc.activePlan?.status === 'active') continue

    const scheduleEntry = npc.schedule.find((s) => s.timeSlot === currentTime)
    if (!scheduleEntry) continue

    const targetLocation = scheduleEntry.locationId
    if (npc.currentLocationId !== targetLocation) {
      const fromLocation = npc.currentLocationId
      moveNpc(npc.id, targetLocation)
      movements.push({
        npcId: npc.id,
        fromLocationId: fromLocation,
        toLocationId: targetLocation,
      })
    }
  }

  return movements
}
