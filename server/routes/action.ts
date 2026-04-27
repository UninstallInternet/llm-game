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
      // Interactive group activity — NPCs react to the player's action ONLY
      // The player stays in control and can continue interacting
      const { buildGroupConversationPrompt } = await import('../llm/prompts.js')
      const { llmCall: llmCallFn } = await import('../llm/client.js')

      const groupNames = mentionedNpcs.map((n) => n.name).join(', ')
      const { system, user: baseUser } = buildGroupConversationPrompt(mentionedNpcs, world, true)

      const reactionPrompt = `${baseUser}

THE VISITOR just did: "${action}"

Generate ONLY the NPCs' reactions — do NOT generate any visitor/player dialogue or actions. The visitor will respond in their own time.

Each NPC reacts in character: some enthusiastic, others reluctant, others cautious. Show their personality through body language and short dialogue. 3-5 lines of NPC-ONLY reactions.`

      try {
        const rawResponse = await llmCallFn('simulation', system, reactionPrompt, true)
        let cleaned = rawResponse.trim()
        if (cleaned.startsWith('```')) {
          cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
        }
        const parsed = JSON.parse(cleaned) as {
          dialogue?: Array<{ speaker: string; says: string }>
          summary: string
          outcome?: { agreement_reached?: string | null; item_transferred?: { from: string; to: string; item: string } | null; conflict?: string | null }
          takeaways?: Record<string, { knowledge: string; mood_shift: string | null; internal_reaction: string }>
        }

        // Build narrative from NPC-only reactions
        const npcReactions = (parsed.dialogue ?? [])
          .filter((d) => d.speaker.toLowerCase() !== 'visitor' && d.speaker.toLowerCase() !== 'player')
          .map((d) => `${d.speaker}: ${d.says}`)
          .join('\n\n')
        const narrative = npcReactions || parsed.summary || `${groupNames} react to your action.`

        // Give all participants knowledge
        for (const npc of mentionedNpcs) {
          const takeaway = parsed.takeaways?.[npc.name] ?? parsed.takeaways?.[npc.id]
          addNpcKnowledge(npc.id, [{
            id: uuid(),
            content: takeaway?.knowledge ?? `The visitor initiated: ${action}. ${parsed.summary}`,
            source: 'experienced with visitor',
            confidence: 1.0,
            importance: 0.8,
            turnLearned: world.currentTick,
            isSecret: false,
          }])
          if (takeaway?.mood_shift) {
            const { updateNpcMoodGeneral: updateMood } = await import('../game/state.js')
            updateMood(npc.id, takeaway.mood_shift, `after ${action} with visitor`)
          }
        }

        if (parsed.outcome?.agreement_reached) {
          const { addNpcAgreement: addAgreement } = await import('../game/state.js')
          for (const npc of mentionedNpcs) {
            addAgreement(npc.id, 'player', parsed.outcome.agreement_reached, world.currentTick)
          }
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
      } catch (err) {
        console.error('Group activity reaction failed:', err)
      }
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
