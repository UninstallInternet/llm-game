import { Router } from 'express'
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

// Auto-load the most recent save on first request
let autoLoaded = false
async function autoLoadLastSave(): Promise<void> {
  if (autoLoaded) return
  autoLoaded = true
  const saves = await listSaves()
  if (saves.length > 0) {
    const loaded = await loadSavedGame(saves[0].id)
    if (loaded) {
      console.log(`Auto-loaded save: ${saves[0].name}`)
      startSimulation()
    }
  }
}

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
      npcCount || 10,
      locationCount || 6,
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
      inventory: [],
      physical: { health: 100, energy: 100, injuries: [], status: 'alive' },
      actionLog: [],
    }

    setWorldAndPlayer(world, player)
    await persistGame()
    autoLoaded = true
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

gameRoutes.get('/state', async (_req, res) => {
  await autoLoadLastSave()

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

gameRoutes.post('/save', async (_req, res) => {
  if (!isGameActive()) {
    res.json({ success: false, error: 'No active game' } satisfies ApiResponse<never>)
    return
  }
  await persistGame()
  res.json({ success: true, data: { message: 'Game saved' } })
})

gameRoutes.post('/load', async (req, res) => {
  const { saveId } = req.body as { saveId: string }
  if (!saveId) {
    res.json({ success: false, error: 'saveId required' } satisfies ApiResponse<never>)
    return
  }

  stopSimulation()
  const loaded = await loadSavedGame(saveId)
  if (!loaded) {
    res.json({ success: false, error: 'Save not found' } satisfies ApiResponse<never>)
    return
  }

  autoLoaded = true
  startSimulation()

  const response: ApiResponse<GameStateResponse> = {
    success: true,
    data: { world: getWorld(), player: getPlayer() },
  }
  res.json(response)
})

gameRoutes.get('/saves', async (_req, res) => {
  const saves = await listSaves()
  res.json({ success: true, data: saves })
})
