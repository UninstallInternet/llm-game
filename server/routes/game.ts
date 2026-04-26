import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import type { ApiResponse, GameStateResponse, GenerateWorldRequest, Player } from '../../shared/types.js'
import { generateWorld } from '../llm/world-generator.js'
import {
  getWorld,
  getPlayer,
  setWorldAndPlayer,
  isGameActive,
  persistGame,
  loadSavedGame,
} from '../game/state.js'
import { listSaves } from '../db/database.js'
import { startSimulation, stopSimulation } from '../simulation/engine.js'
import { broadcastEvent } from './events.js'

export const gameRoutes = Router()

gameRoutes.post('/new', async (req, res) => {
  try {
    const { settingDescription, npcCount, locationCount } = req.body as GenerateWorldRequest

    if (!settingDescription) {
      res.json({ success: false, error: 'settingDescription is required' } satisfies ApiResponse<never>)
      return
    }

    stopSimulation()

    const world = await generateWorld(
      settingDescription,
      npcCount || 25,
      locationCount || 12,
      (phase, message) => {
        broadcastEvent({ type: 'world_generated', data: { phase, message } })
      }
    )

    const startLocation = world.locations.find((l) => l.isPublic) ?? world.locations[0]

    const player: Player = {
      currentLocationId: startLocation.id,
      knownNpcIds: [],
      knownLocationIds: [startLocation.id],
      notes: [],
      conversationHistory: {},
    }

    setWorldAndPlayer(world, player)
    persistGame()
    startSimulation()

    const response: ApiResponse<GameStateResponse> = {
      success: true,
      data: { world, player },
    }
    res.json(response)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    res.status(500).json({ success: false, error: message } satisfies ApiResponse<never>)
  }
})

gameRoutes.get('/state', (_req, res) => {
  if (!isGameActive()) {
    res.json({ success: false, error: 'No active game' } satisfies ApiResponse<never>)
    return
  }

  const response: ApiResponse<GameStateResponse> = {
    success: true,
    data: { world: getWorld(), player: getPlayer() },
  }
  res.json(response)
})

gameRoutes.post('/save', (_req, res) => {
  if (!isGameActive()) {
    res.json({ success: false, error: 'No active game' } satisfies ApiResponse<never>)
    return
  }
  persistGame()
  res.json({ success: true, data: { message: 'Game saved' } })
})

gameRoutes.post('/load', (req, res) => {
  const { saveId } = req.body as { saveId: string }
  if (!saveId) {
    res.json({ success: false, error: 'saveId required' } satisfies ApiResponse<never>)
    return
  }

  stopSimulation()
  const loaded = loadSavedGame(saveId)
  if (!loaded) {
    res.json({ success: false, error: 'Save not found' } satisfies ApiResponse<never>)
    return
  }

  startSimulation()

  const response: ApiResponse<GameStateResponse> = {
    success: true,
    data: { world: getWorld(), player: getPlayer() },
  }
  res.json(response)
})

gameRoutes.get('/saves', (_req, res) => {
  const saves = listSaves()
  res.json({ success: true, data: saves })
})
