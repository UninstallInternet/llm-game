import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import type { ApiResponse, PlayerActionRequest, PlayerActionResponse, Item } from '../../shared/types.js'
import {
  getWorld,
  getPlayer,
  getLocation,
  isGameActive,
  persistGame,
  addNpcKnowledge,
} from '../game/state.js'
import { judgeAction, searchContainer } from '../llm/judge.js'
import { onPlayerAction } from '../simulation/engine.js'

export const actionRoutes = Router()

// Track active group interaction sessions
interface ActiveGroupSession {
  participantIds: string[]
  locationId: string
  startedAtTick: number
  history: Array<{ speaker: string; says: string }>
}

let activeGroupSession: ActiveGroupSession | null = null

export function getActiveGroupSession(): ActiveGroupSession | null {
  return activeGroupSession
}

export function clearActiveGroupSession(): void {
  activeGroupSession = null
}

actionRoutes.post('/', async (req, res) => {
  try {
    if (!isGameActive()) {
      res.json({ success: false, error: 'No active game' } satisfies ApiResponse<never>)
      return
    }

    const { action } = req.body as PlayerActionRequest
    if (!action?.trim()) {
      res.json({ success: false, error: 'Action cannot be empty' } satisfies ApiResponse<never>)
      return
    }

    const world = getWorld()
    const player = getPlayer()
    const location = getLocation(player.currentLocationId)

    if (!location) {
      res.json({ success: false, error: 'Invalid location' } satisfies ApiResponse<never>)
      return
    }

    const actionLower = action.toLowerCase()

    // ── Check for active group session — continue it unless player explicitly leaves ──
    const isEndingAction = actionLower.includes('leave') || actionLower.includes('stop') ||
      actionLower.includes('end') || actionLower.includes('go to') || actionLower.includes('walk away') ||
      actionLower.includes('move to') || actionLower.includes('search') || actionLower.includes('pick up')

    if (activeGroupSession && !isEndingAction) {
      // Continue the active group session — route to the same NPCs
      const sessionNpcs = world.npcs.filter((n) => activeGroupSession!.participantIds.includes(n.id))
      if (sessionNpcs.length > 0 && sessionNpcs[0].currentLocationId === player.currentLocationId) {
        // Add player action to session history
        activeGroupSession.history.push({ speaker: 'Visitor', says: action })

        const { buildNpcSystemPrompt } = await import('../llm/prompts.js')
        const { llmCall: llmCallFn } = await import('../llm/client.js')
        const { updateNpcMoodGeneral: updateMood, addNpcAgreement: addAgreement, updateNpcStateFlags } = await import('../game/state.js')

        const reactions: Array<{ npcName: string; response: string }> = []

        // Recent session context for each NPC
        const recentHistory = activeGroupSession.history.slice(-8)
          .map((h) => `${h.speaker}: ${h.says}`).join('\n')

        for (const npc of sessionNpcs) {
          try {
            const systemPrompt = buildNpcSystemPrompt(npc, world, action)
            const otherNames = sessionNpcs.filter((n) => n.id !== npc.id).map((n) => n.name).join(', ')

            const prompt = `You are in an ongoing group activity with the visitor${otherNames ? ` and ${otherNames}` : ''}.

RECENT EXCHANGE:
${recentHistory}

The visitor just said/did: "${action}"

React naturally — continue the activity. 1-3 sentences with *actions* and "dialogue".
Do NOT speak for the visitor or other NPCs.

JSON only:
{
  "reaction": "your response",
  "internal_thought": "private thought",
  "mood_change": { "current": "mood", "toward_player_delta": -5 to 5, "reason": "why" } or null,
  "new_knowledge": [{ "content": "what happened", "source": "experienced", "importance": 0.3 }],
  "state_changes": null or ["add:tag"],
  "new_agreement": null or "agreed to"
}`

            const raw = await llmCallFn('conversation', systemPrompt, prompt, true)
            let cleaned = raw.trim()
            if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
            const parsed = JSON.parse(cleaned) as {
              reaction: string; internal_thought?: string
              mood_change?: { current: string; toward_player_delta: number; reason: string } | null
              new_knowledge?: Array<{ content: string; source: string; importance?: number }> | null
              state_changes?: string[] | null; new_agreement?: string | null
            }

            reactions.push({ npcName: npc.name, response: parsed.reaction || '...' })
            activeGroupSession!.history.push({ speaker: npc.name, says: parsed.reaction || '...' })

            if (parsed.mood_change) {
              const { updateNpcMood } = await import('../game/state.js')
              updateNpcMood(npc.id, parsed.mood_change.current, parsed.mood_change.toward_player_delta, parsed.mood_change.reason)
            }
            if (parsed.new_knowledge?.length) {
              addNpcKnowledge(npc.id, parsed.new_knowledge.map((k) => ({
                id: uuid(), content: k.content, source: k.source,
                confidence: 0.9, importance: Math.max(0.1, Math.min(1.0, k.importance ?? 0.5)),
                turnLearned: world.currentTick, isSecret: false,
              })))
            }
            if (parsed.state_changes) updateNpcStateFlags(npc.id, parsed.state_changes)
            if (parsed.new_agreement) addAgreement(npc.id, 'player', parsed.new_agreement, world.currentTick)
          } catch (err) {
            reactions.push({ npcName: npc.name, response: '*continues the activity*' })
          }
        }

        onPlayerAction()
        persistGame()

        res.json({
          success: true,
          data: {
            outcome: 'strong_success' as const,
            narrative: reactions.map((r) => `${r.npcName}: ${r.response}`).join('\n\n'),
            itemFound: null, healthDelta: 0, energyDelta: -3, injury: null,
          },
        } satisfies ApiResponse<PlayerActionResponse>)
        return
      } else {
        // NPCs left or player moved — end the session
        activeGroupSession = null
      }
    }

    // End group session on explicit ending actions
    if (activeGroupSession && isEndingAction) {
      // Store the full session as a memory for all participants
      const sessionSummary = activeGroupSession.history
        .slice(-10)
        .map((h) => `${h.speaker}: ${h.says.slice(0, 50)}`).join('; ')
      for (const pid of activeGroupSession.participantIds) {
        addNpcKnowledge(pid, [{
          id: uuid(),
          content: `Group activity with the visitor ended. What happened: ${sessionSummary}`,
          source: 'experienced — session ended',
          confidence: 1.0,
          importance: 0.7,
          turnLearned: world.currentTick,
          isSecret: false,
        }])
      }
      activeGroupSession = null
    }

    // ── Search action: try to find items in containers ──
    if (actionLower.includes('search') || actionLower.includes('look through') || actionLower.includes('examine')) {
      // Find best container to search: prefer unsearched, then least-searched with cooldown passed
      const sortedContainers = [...location.containers].sort((a, b) => {
        const aCount = a.searchCount ?? (a as { searched?: boolean }).searched ? 1 : 0
        const bCount = b.searchCount ?? (b as { searched?: boolean }).searched ? 1 : 0
        return (aCount as number) - (bCount as number)
      })
      const unsearched = sortedContainers.find((c) => {
        const count = c.searchCount ?? 0
        const lastTick = c.lastSearchTick ?? 0
        return count === 0 || (world.currentTick - lastTick >= 6)
      })

      if (!unsearched) {
        onPlayerAction()
        const response: ApiResponse<PlayerActionResponse> = {
          success: true,
          data: {
            outcome: 'partial_success',
            narrative: `You search ${location.name} but it's too soon since the last search. Try again later.`,
            itemFound: null,
            healthDelta: 0,
            energyDelta: -3,
            injury: null,
          },
        }
        res.json(response)
        return
      }

      const playerAsNpc = {
        id: 'player',
        name: 'You',
        occupation: 'Traveler',
        occupationTags: ['general-knowledge', 'investigation'],
        physical: player.physical,
        inventory: player.inventory,
      }

      const item = await searchContainer(
        playerAsNpc as Parameters<typeof searchContainer>[0],
        location,
        unsearched.id,
        world.currentTick
      )

      onPlayerAction()

      if (item) {
        player.inventory.push(item)
        player.actionLog.push({
          tick: world.currentTick,
          action: `Searched ${unsearched.name}`,
          result: `Found ${item.name}`,
        })
        persistGame()

        // Notify witnesses
        for (const w of world.npcs.filter((n) => n.currentLocationId === player.currentLocationId && n.physical?.status === 'alive')) {
          addNpcKnowledge(w.id, [{
            id: uuid(),
            content: `The visitor searched the ${unsearched.name} and found a ${item.name}.`,
            source: 'witnessed',
            confidence: 0.9,
            importance: 0.4,
            turnLearned: world.currentTick,
            isSecret: false,
          }])
        }

        const response: ApiResponse<PlayerActionResponse> = {
          success: true,
          data: {
            outcome: 'strong_success',
            narrative: `You search the ${unsearched.name} and find a ${item.name}! ${item.description}`,
            itemFound: item,
            healthDelta: 0,
            energyDelta: -5,
            injury: null,
          },
        }
        res.json(response)
        return
      }

      player.actionLog.push({
        tick: world.currentTick,
        action: `Searched ${unsearched.name}`,
        result: 'Nothing useful',
      })

      const response: ApiResponse<PlayerActionResponse> = {
        success: true,
        data: {
          outcome: 'failure',
          narrative: `You search the ${unsearched.name} but find nothing useful.`,
          itemFound: null,
          healthDelta: 0,
          energyDelta: -3,
          injury: null,
        },
      }
      res.json(response)
      return
    }

    // ── Pick up item from location ──
    if (actionLower.includes('pick up') || actionLower.includes('take') || actionLower.includes('grab')) {
      const itemName = action.replace(/^(pick up|take|grab)\s+/i, '').trim()
      const itemIdx = location.items.findIndex((i) =>
        i.name.toLowerCase().includes(itemName.toLowerCase())
      )

      if (itemIdx === -1) {
        res.json({
          success: true,
          data: {
            outcome: 'failure',
            narrative: `You don't see a "${itemName}" here.`,
            itemFound: null,
            healthDelta: 0,
            energyDelta: 0,
            injury: null,
          },
        } satisfies ApiResponse<PlayerActionResponse>)
        return
      }

      const item = location.items.splice(itemIdx, 1)[0]
      item.ownerId = 'player'
      item.locationId = null
      player.inventory.push(item)
      onPlayerAction()
      persistGame()

      res.json({
        success: true,
        data: {
          outcome: 'strong_success',
          narrative: `You pick up the ${item.name}. ${item.description}`,
          itemFound: item,
          healthDelta: 0,
          energyDelta: -2,
          injury: null,
        },
      } satisfies ApiResponse<PlayerActionResponse>)
      return
    }

    // ── Use item: check inventory first ──
    if (actionLower.includes('use ') || actionLower.includes('apply ') || actionLower.includes('activate ')) {
      const itemRef = action.replace(/^(use|apply|activate)\s+/i, '').replace(/\s+(on|with|at|to)\s+.*/i, '').trim()
      const hasItem = player.inventory.some((i) =>
        i.name.toLowerCase().includes(itemRef.toLowerCase()) ||
        itemRef.toLowerCase().includes(i.name.toLowerCase())
      )
      if (!hasItem && itemRef.length > 2) {
        onPlayerAction()
        res.json({
          success: true,
          data: {
            outcome: 'failure',
            narrative: `You don't have "${itemRef}" in your inventory.`,
            itemFound: null,
            healthDelta: 0,
            energyDelta: 0,
            injury: null,
          },
        } satisfies ApiResponse<PlayerActionResponse>)
        return
      }
    }

    // ── Group activity: detect multiple NPC names in action ──
    const npcsAtLocation = world.npcs.filter((n) => n.currentLocationId === player.currentLocationId)
    const mentionedNpcs = npcsAtLocation.filter((n) => {
      const firstName = n.name.split(' ')[0].toLowerCase()
      if (firstName.length < 3) return actionLower.includes(n.name.toLowerCase())
      // Word boundary match to avoid "Al" matching "steal"
      const firstNamePattern = new RegExp(`\\b${firstName}\\b`)
      return firstNamePattern.test(actionLower) || actionLower.includes(n.name.toLowerCase())
    })

    if (mentionedNpcs.length >= 1) {
      // Each NPC gets their OWN LLM call with full personal context
      const { buildNpcSystemPrompt } = await import('../llm/prompts.js')
      const { llmCall: llmCallFn } = await import('../llm/client.js')
      const { updateNpcMoodGeneral: updateMood, addNpcAgreement: addAgreement } = await import('../game/state.js')

      const otherNpcNames = mentionedNpcs.map((n) => n.name).join(', ')
      const reactions: Array<{ npcName: string; response: string }> = []

      for (const npc of mentionedNpcs) {
        try {
          // Full personal system prompt — all their memories, agreements, personality
          const systemPrompt = buildNpcSystemPrompt(npc, world, action)

          const otherParticipants = mentionedNpcs
            .filter((n) => n.id !== npc.id)
            .map((n) => `${n.name} (${n.occupation}${(n.stateFlags?.length ?? 0) > 0 ? `, ${n.stateFlags.join('/')}` : ''})`)
            .join(', ')

          const reactionPrompt = `The visitor just did this action in your presence: "${action}"
${otherParticipants ? `Also present and involved: ${otherParticipants}` : ''}

React to what the visitor did. Respond in character with *actions* and "dialogue". 1-3 sentences.
Do NOT speak for the visitor or other NPCs — only YOUR reaction.

Respond with ONLY JSON:
{
  "reaction": "your *actions* and \"dialogue\" response",
  "internal_thought": "what you privately think",
  "mood_change": { "current": "mood", "toward_player_delta": -5 to 5, "reason": "why" } or null,
  "new_knowledge": [{ "content": "what you observed/learned", "source": "witnessed", "importance": 0.1 to 1.0 }],
  "state_changes": null or ["add:tag"],
  "new_agreement": null or "what you agreed to"
}`

          const rawResponse = await llmCallFn('conversation', systemPrompt, reactionPrompt, true)
          let cleaned = rawResponse.trim()
          if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
          }
          const parsed = JSON.parse(cleaned) as {
            reaction: string
            internal_thought?: string
            mood_change?: { current: string; toward_player_delta: number; reason: string } | null
            new_knowledge?: Array<{ content: string; source: string; importance?: number }> | null
            state_changes?: string[] | null
            new_agreement?: string | null
          }

          reactions.push({ npcName: npc.name, response: parsed.reaction || '...' })

          // Apply all state changes — same as chat route
          if (parsed.mood_change) {
            const { updateNpcMood } = await import('../game/state.js')
            updateNpcMood(npc.id, parsed.mood_change.current, parsed.mood_change.toward_player_delta, parsed.mood_change.reason)
          }
          if (parsed.new_knowledge && parsed.new_knowledge.length > 0) {
            addNpcKnowledge(npc.id, parsed.new_knowledge.map((k) => ({
              id: uuid(),
              content: k.content,
              source: k.source,
              confidence: 0.9,
              importance: Math.max(0.1, Math.min(1.0, k.importance ?? 0.5)),
              turnLearned: world.currentTick,
              isSecret: false,
            })))
          }
          if (parsed.state_changes) {
            const { updateNpcStateFlags } = await import('../game/state.js')
            updateNpcStateFlags(npc.id, parsed.state_changes)
          }
          if (parsed.new_agreement) {
            addAgreement(npc.id, 'player', parsed.new_agreement, world.currentTick)
          }
        } catch (err) {
          console.error(`NPC reaction failed for ${npc.name}:`, err)
          reactions.push({ npcName: npc.name, response: '*looks on without reacting*' })
        }
      }

      const narrative = reactions.map((r) => `${r.npcName}: ${r.response}`).join('\n\n')

      // Start a group session so follow-up actions stay with these NPCs
      activeGroupSession = {
        participantIds: mentionedNpcs.map((n) => n.id),
        locationId: player.currentLocationId,
        startedAtTick: world.currentTick,
        history: [
          { speaker: 'Visitor', says: action },
          ...reactions.map((r) => ({ speaker: r.npcName, says: r.response })),
        ],
      }

      onPlayerAction()
      persistGame()

      res.json({
        success: true,
        data: {
          outcome: 'strong_success' as const,
          narrative,
          itemFound: null,
          healthDelta: 0,
          energyDelta: -5,
          injury: null,
        },
      } satisfies ApiResponse<PlayerActionResponse>)
      return
    }

    // ── Any other action: Game Master adjudicates ──
    const npcsHere = npcsAtLocation
      .map((n) => `${n.name} (${n.occupation})`)
      .join(', ')

    const result = await judgeAction({
      actor: {
        name: 'The player',
        occupation: 'Traveler/Investigator',
        tags: ['investigation', 'general-knowledge'],
        health: player.physical.health,
        injuries: player.physical.injuries,
      },
      action,
      target: {
        name: location.name,
        tags: location.tags,
      },
      environment: {
        name: location.name,
        tags: [...location.tags, ...(npcsHere ? [`people: ${npcsHere}`] : [])],
      },
      context: `Player inventory: ${player.inventory.map((i) => i.name).join(', ') || 'nothing'}. Location fixtures: ${location.fixtures.join(', ') || 'none'}. NPCs present: ${npcsHere || 'nobody'}.`,
    })

    // Apply physical effects to player
    if (result.effects) {
      player.physical.health = Math.max(0, Math.min(100,
        player.physical.health + result.effects.actorHealthDelta
      ))
      player.physical.energy = Math.max(0, Math.min(100,
        player.physical.energy + (result.effects.actorEnergyDelta ?? -5)
      ))
      if (result.effects.actorInjury) {
        player.physical.injuries.push(result.effects.actorInjury)
      }
      if (player.physical.health <= 0) {
        player.physical.status = 'dead'
      } else if (player.physical.health <= 15) {
        player.physical.status = 'unconscious'
      }
    }

    player.actionLog.push({
      tick: world.currentTick,
      action,
      result: `${result.outcome}: ${result.narrativeHint}`,
    })

    // Notify NPCs at the same location about what the player did
    const witnesses = world.npcs.filter((n) =>
      n.currentLocationId === player.currentLocationId && n.physical?.status === 'alive'
    )
    for (const witness of witnesses) {
      addNpcKnowledge(witness.id, [{
        id: uuid(),
        content: `The visitor ${action}. ${result.narrativeHint}`,
        source: 'witnessed',
        confidence: 0.9,
        importance: 0.5,
        turnLearned: world.currentTick,
        isSecret: false,
      }])
    }

    onPlayerAction()
    persistGame()

    const response: ApiResponse<PlayerActionResponse> = {
      success: true,
      data: {
        outcome: result.outcome,
        narrative: result.narrativeHint,
        itemFound: null,
        healthDelta: result.effects?.actorHealthDelta ?? 0,
        energyDelta: result.effects?.actorEnergyDelta ?? -5,
        injury: result.effects?.actorInjury ?? null,
      },
    }
    res.json(response)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    res.status(500).json({ success: false, error: message } satisfies ApiResponse<never>)
  }
})
