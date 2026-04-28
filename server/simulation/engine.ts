import {
  getWorld,
  isGameActive,
  advanceTime,
  persistGame,
  isNpcBusy,
  completeMeeting,
  addNpcKnowledge,
} from '../game/state.js'
import { v4 as uuid } from 'uuid'
import { broadcastEvent } from '../routes/events.js'
import { moveNpcsToSchedule } from './npc-behavior.js'
import { propagateInfo } from './info-share.js'
import { checkEventTriggers } from './events.js'
import { runNpcConversations } from './npc-conversations.js'
import { processNpcTurn } from './npc-planner.js'
import { runReflections } from './npc-reflection.js'
import { MAX_SIMULATION_LLM_CALLS_PER_TICK } from '../../shared/constants.js'

let actionCount = 0
let tickInProgress = false
const ACTIONS_PER_TICK = 2

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

// Full tick with time advancement, NPC conversations, planning, events
async function runTick(): Promise<void> {
  if (tickInProgress) return
  tickInProgress = true

  try {
    // 1. Advance time
    const newTime = advanceTime()
    broadcastEvent({ type: 'time_advanced', data: newTime })

    // 2. Move NPCs
    const movements = moveNpcsToSchedule()
    for (const move of movements) {
      broadcastEvent({ type: 'npc_moved', data: move })
    }

    // 2.5 Meeting cleanup — mark meetings as kept or missed
    const worldForMeetings = getWorld()
    for (const npc of worldForMeetings.npcs) {
      for (const meeting of (npc.scheduledMeetings ?? []).filter((m) => m.status === 'pending')) {
        if (meeting.tick < worldForMeetings.currentTick - 3) {
          // Meeting time passed — check if both were at the location
          const other = worldForMeetings.npcs.find((n) => n.id === meeting.withId)
          if (other && npc.currentLocationId === meeting.locationId && other.currentLocationId === meeting.locationId) {
            completeMeeting(npc.id, meeting.withId)
            completeMeeting(meeting.withId, npc.id)
          } else {
            // Missed meeting
            addNpcKnowledge(npc.id, [{
              id: uuid(),
              content: `${other?.name ?? 'Someone'} missed our scheduled meeting about: ${meeting.purpose.slice(0, 50)}`,
              source: 'observed',
              confidence: 1.0,
              importance: 0.6,
              turnLearned: worldForMeetings.currentTick,
              isSecret: false,
            }])
            completeMeeting(npc.id, meeting.withId) // mark as kept to stop re-checking
          }
        }
      }
    }

    // 3. Silent info propagation
    const shares = propagateInfo()
    for (const share of shares) {
      broadcastEvent({ type: 'info_shared', data: share })
    }

    // 3.5 Tag awareness — NPCs notice visible tags on co-located NPCs
    const worldForTags = getWorld()
    for (const npc of worldForTags.npcs) {
      if (npc.physical.status === 'dead' || npc.physical.status === 'unconscious') continue
      const coLocated = worldForTags.npcs.filter((n) => n.id !== npc.id && n.currentLocationId === npc.currentLocationId)
      for (const other of coLocated) {
        const visibleTags = (other.stateFlags ?? []).filter((f) => f !== 'hiding' && f !== 'focused')
        if (visibleTags.length === 0) continue
        // Check if NPC already knows about this specific combination
        const tagStr = visibleTags.join(', ')
        const alreadyKnows = npc.knowledge.some((k) =>
          k.source === 'observed' && k.content.includes(other.name.split(' ')[0]) &&
          visibleTags.every((t) => k.content.toLowerCase().includes(t))
        )
        if (!alreadyKnows) {
          addNpcKnowledge(npc.id, [{
            id: uuid(),
            content: `${other.name} appears to be ${tagStr}. This is noticeable.`,
            source: 'observed',
            confidence: 1.0,
            importance: 0.5,
            turnLearned: worldForTags.currentTick,
            isSecret: false,
          }])
        }
      }
    }

    // 4. NPC-to-NPC conversations (1-2 LLM calls)
    await runNpcConversations()

    // 5. NPC autonomous actions with budget control
    let llmBudget = MAX_SIMULATION_LLM_CALLS_PER_TICK - 2
    const updatedWorld = getWorld()

    for (const npc of updatedWorld.npcs) {
      if (llmBudget <= 0) break
      if (isNpcBusy(npc.id)) continue

      // Re-read fresh NPC state (conversations may have completed plan steps)
      const freshNpc = getWorld().npcs.find((n) => n.id === npc.id) ?? npc
      const result = await processNpcTurn(freshNpc, getWorld())
      llmBudget -= result.llmCalls
    }

    // 6. NPC reflections (every 12 ticks)
    await runReflections(updatedWorld)

    // 7. Check event triggers
    const triggered = checkEventTriggers()
    for (const event of triggered) {
      broadcastEvent({ type: 'event_triggered', data: event })
    }

    // 7. Broadcast tick
    broadcastEvent({
      type: 'simulation_tick',
      data: { tick: updatedWorld.currentTick, time: newTime },
    })

    if (updatedWorld.currentTick % 4 === 0) {
      await persistGame()
    }
  } catch (error) {
    console.error('Simulation tick error:', error)
  } finally {
    tickInProgress = false
  }
}
