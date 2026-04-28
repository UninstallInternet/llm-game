import { getWorld, moveNpc, isNpcBusy, getUpcomingMeetings } from '../game/state.js'
import { IMMOBILIZING_TAGS } from '../../shared/constants.js'

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
    if (isNpcBusy(npc.id)) continue
    // Immobilized NPCs cannot move
    if (npc.physical.status !== 'alive' || (npc.stateFlags ?? []).some((f) => IMMOBILIZING_TAGS.has(f))) continue

    // Priority 1: Scheduled meetings (override plans AND schedule)
    const meetings = getUpcomingMeetings(npc.id, world.currentTick)
    const imminentMeeting = meetings.find((m) => m.tick <= world.currentTick + 2)
    if (imminentMeeting && npc.currentLocationId !== imminentMeeting.locationId) {
      const fromLocation = npc.currentLocationId
      moveNpc(npc.id, imminentMeeting.locationId)
      movements.push({ npcId: npc.id, fromLocationId: fromLocation, toLocationId: imminentMeeting.locationId })
      continue
    }

    // Priority 2: Active plans
    if (npc.activePlan?.status === 'active') continue

    // Priority 3: Schedule
    const scheduleEntry = npc.schedule.find((s) => s.timeSlot === currentTime)
    if (!scheduleEntry) continue

    const targetLocation = scheduleEntry.locationId
    if (npc.currentLocationId !== targetLocation) {
      const fromLocation = npc.currentLocationId
      moveNpc(npc.id, targetLocation)
      movements.push({ npcId: npc.id, fromLocationId: fromLocation, toLocationId: targetLocation })
    }
  }

  return movements
}
