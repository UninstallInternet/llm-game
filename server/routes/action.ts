import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import type { ApiResponse, PlayerActionRequest, PlayerActionResponse, Item } from '../../shared/types.js'
import {
  getWorld,
  getPlayer,
  getLocation,
  getNpc,
  isGameActive,
  persistGame,
  addNpcKnowledge,
  updateNpcPlan,
  moveNpc,
  movePlayer,
  markNpcBusy,
  markNpcFree,
  updateNpcStateFlags,
  applyPhysicalEffects,
} from '../game/state.js'
import { broadcastEvent } from './events.js'
import { judgeAction, searchContainer } from '../llm/judge.js'
import { onPlayerAction } from '../simulation/engine.js'

export const actionRoutes = Router()

// Track active group interaction sessions
interface ActiveGroupSession {
  participantIds: string[]
  locationId: string
  startedAtTick: number
  history: Array<{ speaker: string; says: string }>
  followPlayer: boolean
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

    // ── Physical actions break group sessions — combat/arrest/etc take priority ──
    const combatVerbs = ['punch', 'attack', 'fight', 'hit', 'kick', 'stab', 'shove', 'tackle', 'restrain', 'arrest', 'tie', 'steal', 'pickpocket', 'seduce', 'undress', 'strip', 'heal', 'bandage', 'poison', 'drug', 'knock', 'kill', 'shoot', 'slash', 'cut']
    const isPhysicalVerb = combatVerbs.some((v) => actionLower.includes(v))
    if (isPhysicalVerb && activeGroupSession) {
      // End group session — physical actions take priority
      for (const pid of activeGroupSession.participantIds) markNpcFree(pid)
      activeGroupSession = null
    }

    // ── Check for active group session — continue it unless player explicitly leaves ──
    const isGroupTravel = activeGroupSession?.followPlayer && (actionLower.includes('go to') || actionLower.includes('move to'))
    // Only end session if the action STARTS with these verbs (not mentioned mid-sentence in dialogue)
    const isEndingAction = !isGroupTravel && (
      actionLower.includes('leave') || actionLower.includes('walk away') ||
      actionLower.startsWith('stop') || actionLower.startsWith('end') ||
      actionLower.startsWith('go to') || actionLower.startsWith('move to') ||
      actionLower.startsWith('search') || actionLower.startsWith('pick up')
    )

    // ── Group travel: move player + all session NPCs together ──
    if (isGroupTravel && activeGroupSession) {
      // Extract target location from action — match location name bidirectionally
      const targetLoc = world.locations.find((l) => {
        if (l.id === player.currentLocationId) return false
        const locLower = l.name.toLowerCase()
        return actionLower.includes(locLower) || locLower.includes(actionLower.replace(/.*(?:go to|move to)\s+/i, '').replace(/\s+with\s+.*/i, '').trim())
      })
      if (targetLoc && targetLoc.id !== player.currentLocationId) {
          // Move player
          const fromLoc = player.currentLocationId
          movePlayer(targetLoc.id)
          // Move all session NPCs
          for (const pid of activeGroupSession.participantIds) {
            moveNpc(pid, targetLoc.id)
            broadcastEvent({ type: 'npc_moved', data: { npcId: pid, fromLocationId: fromLoc, toLocationId: targetLoc.id } })
          }
          activeGroupSession.locationId = targetLoc.id
          activeGroupSession.history.push({ speaker: 'Narrator', says: `The group travels to ${targetLoc.name}.` })

          onPlayerAction()
          persistGame()

          const npcNames = activeGroupSession.participantIds.map((pid) => world.npcs.find((n) => n.id === pid)?.name ?? 'someone').join(', ')
          res.json({ success: true, data: { outcome: 'strong_success' as const, narrative: `You travel to ${targetLoc.name} together with ${npcNames}.`, itemFound: null, healthDelta: 0, energyDelta: -5, injury: null } } satisfies ApiResponse<PlayerActionResponse>)
          return
      }
    }

    if (activeGroupSession && !isEndingAction) {
      // Continue the active group session using unified group conversation
      const sessionNpcs = world.npcs.filter((n) => activeGroupSession!.participantIds.includes(n.id))
      if (sessionNpcs.length > 0 && sessionNpcs[0].currentLocationId === player.currentLocationId) {
        activeGroupSession.history.push({ speaker: 'Visitor', says: action })

        const { buildGroupConversationPrompt } = await import('../llm/prompts.js')
        const { llmFunctionCall } = await import('../llm/client.js')
        const { GROUP_CONVERSATION_SCHEMA } = await import('../llm/schemas.js')
        const { applyGroupResult } = await import('../simulation/npc-conversations.js')

        try {
          const { system, user: baseUser } = buildGroupConversationPrompt(sessionNpcs, world, true, `The visitor is leading a group activity`)
          const historyStr = activeGroupSession.history.slice(-8)
            .map((d) => `${d.speaker}: ${d.says}`).join('\n')
          const fullUser = baseUser + `\n\nSESSION HISTORY:\n${historyStr}\n\nThe visitor just said/did: "${action}"\n\nGenerate the group's response. NPCs should react to the visitor AND to each other.`

          const parsed = await llmFunctionCall<{
            dialogue?: Array<{ speaker: string; says: string }>
            summary: string
            concluded: boolean
            outcome?: { agreement_reached?: string | null; item_transferred?: { from: string; to: string; item: string } | null; conflict?: string | null }
            takeaways: Record<string, { knowledge: string; mood_shift: string | null; relationship_deltas: Record<string, number>; internal_reaction: string }>
          }>('conversation', [{ role: 'system', content: system }, { role: 'user', content: fullUser }], GROUP_CONVERSATION_SCHEMA)

          const dialogue = parsed.dialogue ?? []
          for (const d of dialogue) {
            activeGroupSession.history.push({ speaker: d.speaker, says: d.says })
          }

          // Apply results using shared function
          const result = {
            participantIds: sessionNpcs.map((n) => n.id),
            locationId: player.currentLocationId,
            tick: world.currentTick,
            summary: parsed.summary,
            dialogue,
            takeaways: Object.fromEntries(
              Object.entries(parsed.takeaways ?? {}).map(([key, val]) => [
                sessionNpcs.find((p) => p.name === key)?.id ?? key,
                { knowledge: val.knowledge ?? '', moodShift: val.mood_shift ?? null, relationshipDeltas: val.relationship_deltas ?? {}, internalReaction: val.internal_reaction ?? '', tagChanges: (val as { tag_changes?: string[] }).tag_changes ?? [] },
              ])
            ),
            outcome: parsed.outcome ?? null,
          }
          applyGroupResult(result, world)

          const narrative = dialogue.map((d) => `${d.speaker}: ${d.says}`).join('\n\n') || parsed.summary

          onPlayerAction()
          persistGame()

          res.json({
            success: true,
            data: {
              outcome: 'strong_success' as const,
              narrative,
              itemFound: null, healthDelta: 0, energyDelta: -3, injury: null,
            },
          } satisfies ApiResponse<PlayerActionResponse>)
          return
        } catch (err) {
          console.error('Group session failed:', err)
          // Fallback
          onPlayerAction()
          res.json({ success: true, data: { outcome: 'partial_success' as const, narrative: 'The group continues their activity.', itemFound: null, healthDelta: 0, energyDelta: -3, injury: null } } satisfies ApiResponse<PlayerActionResponse>)
          return
        }
      } else {
        activeGroupSession = null
      }
    }

    // ── Check for "invite" / "bring" actions to add NPCs to group session ──
    const inviteMatch = actionLower.match(/(?:invite|bring|ask|call)\s+(\w+)/i)
    if (inviteMatch) {
      const targetName = inviteMatch[1]
      const targetNpc = world.npcs.find((n) =>
        n.currentLocationId === player.currentLocationId &&
        n.name.toLowerCase().includes(targetName.toLowerCase()) &&
        n.physical?.status === 'alive'
      )
      if (targetNpc) {
        if (!activeGroupSession) {
          activeGroupSession = { participantIds: [targetNpc.id], locationId: player.currentLocationId, startedAtTick: world.currentTick, history: [], followPlayer: true }
        } else if (!activeGroupSession.participantIds.includes(targetNpc.id)) {
          activeGroupSession.participantIds.push(targetNpc.id)
        }
        markNpcBusy(targetNpc.id)
        onPlayerAction()
        await persistGame()
        res.json({ success: true, data: { outcome: 'strong_success' as const, narrative: `${targetNpc.name} joins your group.`, itemFound: null, healthDelta: 0, energyDelta: 0, injury: null } } satisfies ApiResponse<PlayerActionResponse>)
        return
      }
    }

    // End group session on explicit ending actions
    if (activeGroupSession && isEndingAction) {
      // Store the full session as a memory for all participants
      const sessionSummary = activeGroupSession.history
        .slice(-10)
        .map((h) => `${h.speaker}: ${h.says.slice(0, 50)}`).join('; ')
      for (const pid of activeGroupSession.participantIds) {
        markNpcFree(pid)
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

    // ── Buy action: purchase from shops ──
    if (actionLower.includes('buy') || actionLower.includes('purchase')) {
      const { buyItem } = await import('../game/state.js')
      // Extract item name from action (e.g. "buy a sword" -> "sword")
      const buyMatch = actionLower.match(/(?:buy|purchase)\s+(?:a\s+|an\s+|the\s+)?(.+)/i)
      const itemName = buyMatch?.[1]?.trim() ?? ''

      if (itemName) {
        const result = buyItem('player', player.currentLocationId, itemName)
        onPlayerAction()
        await persistGame()

        if (result.success && result.item) {
          res.json({ success: true, data: {
            outcome: 'strong_success' as const,
            narrative: `You purchase ${result.item.name} for $${result.price ?? 0}. ${result.item.description}`,
            itemFound: result.item, healthDelta: 0, energyDelta: -1, injury: null,
          } } satisfies ApiResponse<PlayerActionResponse>)
        } else {
          res.json({ success: true, data: {
            outcome: 'failure' as const,
            narrative: result.error === 'Not enough currency'
              ? `You don't have enough money to buy that.`
              : result.error === 'No shop with that item'
                ? `There's no shop here selling that item.`
                : `You can't buy that here.`,
            itemFound: null, healthDelta: 0, energyDelta: 0, injury: null,
          } } satisfies ApiResponse<PlayerActionResponse>)
        }
        return
      }
    }

    // ── Search action: try to find items in containers (only if no group session) ──
    if (!activeGroupSession && (actionLower.includes('search') || actionLower.includes('look through') || actionLower.includes('examine'))) {
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
        await persistGame()

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
    if (actionLower.startsWith('pick up') || actionLower.startsWith('take ') || actionLower.startsWith('grab ')) {
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
      await persistGame()

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
      // ═══ PHASE 1: RESOLUTION — Game Master judges the action for physical consequences ═══
      const targetNpc = mentionedNpcs[0]
      const gmResult = await judgeAction({
        actor: { name: 'Visitor', occupation: 'Traveler', tags: ['general-knowledge'], health: player.physical.health, injuries: player.physical.injuries },
        action,
        target: { name: targetNpc.name, tags: targetNpc.occupationTags, health: targetNpc.physical.health },
        environment: { name: location.name, tags: location.tags },
        context: `Player inventory: ${player.inventory.map((i) => i.name).join(', ') || 'nothing'}`,
      })

      // Apply ALL physical effects — the GM decides what happens
      if (gmResult.effects) {
        applyPhysicalEffects(targetNpc.id, {
          healthDelta: gmResult.effects.targetHealthDelta,
          injury: gmResult.effects.targetInjury,
          statusChange: gmResult.effects.targetStatusChange,
        })
        // Apply GM-determined tags to both actor and target
        if (gmResult.effects.targetTagChanges?.length > 0) {
          updateNpcStateFlags(targetNpc.id, gmResult.effects.targetTagChanges)
        }
        if (gmResult.effects.actorTagChanges?.length > 0) {
          // Actor is the player — apply to player stateFlags if we had them, otherwise skip
        }
        // Fallback: ensure combat damage always adds injured tag
        if (gmResult.effects.targetHealthDelta < 0 && !(gmResult.effects.targetTagChanges ?? []).some((t: string) => t.includes('injured'))) {
          updateNpcStateFlags(targetNpc.id, ['add:injured'])
        }
        if (gmResult.effects.targetStatusChange === 'restrained') {
          updateNpcStateFlags(targetNpc.id, ['add:restrained'])
        }
        if (gmResult.effects.targetStatusChange === 'unconscious' || gmResult.effects.targetStatusChange === 'dead') {
          updateNpcStateFlags(targetNpc.id, [`add:${gmResult.effects.targetStatusChange}`])
        }
        // Apply to player
        applyPhysicalEffects('player' as string, {
          healthDelta: gmResult.effects.actorHealthDelta,
          energyDelta: gmResult.effects.actorEnergyDelta,
          injury: gmResult.effects.actorInjury,
        })
      }

      // Witnesses and target learn about the action
      for (const w of world.npcs.filter((n) => n.currentLocationId === player.currentLocationId && n.id !== targetNpc.id)) {
        addNpcKnowledge(w.id, [{
          id: uuid(), content: `The visitor ${action.slice(0, 80)}. ${gmResult.narrativeHint}`,
          source: 'witnessed', confidence: 0.9, importance: 0.8,
          turnLearned: world.currentTick, isSecret: false,
        }])
      }
      addNpcKnowledge(targetNpc.id, [{
        id: uuid(), content: `The visitor ${gmResult.outcome === 'failure' ? 'tried to' : ''} ${action.slice(0, 60)}. ${gmResult.narrativeHint}`,
        source: 'experienced', confidence: 1.0, importance: 0.9,
        turnLearned: world.currentTick, isSecret: false,
      }])

      // Persist IMMEDIATELY so Phase 2 sees updated state
      await persistGame()

      // ═══ PHASE 2: REACTION — NPCs respond to what just happened ═══
      const { buildGroupConversationPrompt } = await import('../llm/prompts.js')
      const { llmFunctionCall } = await import('../llm/client.js')
      const { GROUP_CONVERSATION_SCHEMA } = await import('../llm/schemas.js')
      const { applyGroupResult } = await import('../simulation/npc-conversations.js')
      const { addNpcAgreement: addAgreement } = await import('../game/state.js')

      // Re-read fresh NPC state (with damage/injuries applied)
      const freshWorld = getWorld()
      const freshNpcs = freshWorld.npcs.filter((n) => mentionedNpcs.some((m) => m.id === n.id))

      try {
        const reasonContext = `The visitor just: ${gmResult.narrativeHint} (${gmResult.outcome})`
        const { system, user: baseUser } = buildGroupConversationPrompt(freshNpcs, freshWorld, true, reasonContext)
        const fullUser = baseUser + `\n\nThe visitor's action: "${action}"\nOutcome: ${gmResult.outcome}. ${gmResult.narrativeHint}\n\nGenerate the NPCs' reactions. They should respond to what the visitor DID, not just talk.`

        const parsed = await llmFunctionCall<{
          dialogue?: Array<{ speaker: string; says: string }>
          summary: string
          concluded: boolean
          outcome?: { agreement_reached?: string | null; item_transferred?: { from: string; to: string; item: string } | null; conflict?: string | null }
          takeaways: Record<string, { knowledge: string; mood_shift: string | null; relationship_deltas: Record<string, number>; internal_reaction: string }>
        }>('conversation', [{ role: 'system', content: system }, { role: 'user', content: fullUser }], GROUP_CONVERSATION_SCHEMA)

        const dialogue = parsed.dialogue ?? []

        // Apply takeaways via shared function
        const result = {
          participantIds: freshNpcs.map((n) => n.id),
          locationId: player.currentLocationId,
          tick: freshWorld.currentTick,
          summary: parsed.summary,
          dialogue,
          takeaways: Object.fromEntries(
            Object.entries(parsed.takeaways ?? {}).map(([key, val]) => [
              freshNpcs.find((p) => p.name === key)?.id ?? key,
              { knowledge: val.knowledge ?? '', moodShift: val.mood_shift ?? null, relationshipDeltas: val.relationship_deltas ?? {}, internalReaction: val.internal_reaction ?? '', tagChanges: (val as { tag_changes?: string[] }).tag_changes ?? [] },
            ])
          ),
          outcome: parsed.outcome ?? null,
        }
        applyGroupResult(result, freshWorld)

        // Check for agreements → trigger replan
        if (parsed.outcome?.agreement_reached) {
          for (const npc of freshNpcs) {
            addAgreement(npc.id, 'player', parsed.outcome.agreement_reached, freshWorld.currentTick)
            import('../simulation/npc-planner.js').then(({ formPlan }) => {
              const n = getNpc(npc.id)
              if (n) formPlan(n, getWorld()).then((plan) => { if (plan) { updateNpcPlan(npc.id, plan); persistGame() } }).catch(() => {})
            }).catch(() => {})
          }
        }

        const narrative = dialogue.length > 0
          ? dialogue.map((d) => `${d.speaker}: ${d.says}`).join('\n\n')
          : parsed.summary

        // Start group session for follow-up
        activeGroupSession = {
          participantIds: freshNpcs.map((n) => n.id),
          locationId: player.currentLocationId,
          startedAtTick: freshWorld.currentTick,
          history: [
            { speaker: 'Visitor', says: action },
            ...dialogue.map((d) => ({ speaker: d.speaker, says: d.says })),
          ],
          followPlayer: true,
        }
        for (const n of freshNpcs) markNpcBusy(n.id)

        onPlayerAction()
        await persistGame()

        res.json({
          success: true,
          data: {
            outcome: gmResult.outcome,
            narrative,
            itemFound: null,
            healthDelta: gmResult.effects?.actorHealthDelta ?? 0,
            energyDelta: gmResult.effects?.actorEnergyDelta ?? -5,
            injury: gmResult.effects?.actorInjury ?? null,
          },
        } satisfies ApiResponse<PlayerActionResponse>)
        return
      } catch (err) {
        // Fallback — GM resolved but reaction failed
        onPlayerAction()
        res.json({
          success: true,
          data: {
            outcome: gmResult.outcome,
            narrative: gmResult.narrativeHint,
            itemFound: null,
            healthDelta: gmResult.effects?.actorHealthDelta ?? 0,
            energyDelta: -5,
            injury: null,
          },
        } satisfies ApiResponse<PlayerActionResponse>)
        return
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
    // Skip trivial actions that add noise to NPC knowledge
    const trivialActions = ['wait', 'observe', 'look around', 'stand', 'sit', 'rest', 'listen', 'explore', 'wander', 'investigate', 'patrol', 'walk around', 'relax', 'order a drink', 'watch', 'stretch', 'hide', 'crouch', 'duck']
    const isTrivial = trivialActions.some((t) => actionLower.includes(t)) && !actionLower.includes('search')
    if (!isTrivial) {
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
    }

    onPlayerAction()
    await persistGame()

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
