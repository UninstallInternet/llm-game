import { Router } from 'express'
import type { ApiResponse, NPC, Location } from '../../shared/types.js'
import {
  getWorld,
  getPlayer,
  getLocation,
  getNpc,
  getNpcsAtLocation,
  movePlayer,
  isGameActive,
} from '../game/state.js'

export const worldRoutes = Router()

worldRoutes.get('/location/:id', (req, res) => {
  if (!isGameActive()) {
    res.json({ success: false, error: 'No active game' } satisfies ApiResponse<never>)
    return
  }

  const location = getLocation(req.params.id)
  if (!location) {
    res.json({ success: false, error: 'Location not found' } satisfies ApiResponse<never>)
    return
  }

  const npcsHere = getNpcsAtLocation(location.id)

  res.json({
    success: true,
    data: { location, npcs: npcsHere },
  })
})

worldRoutes.post('/move', (req, res) => {
  if (!isGameActive()) {
    res.json({ success: false, error: 'No active game' } satisfies ApiResponse<never>)
    return
  }

  const { locationId } = req.body as { locationId: string }
  const player = getPlayer()

  // Check if location is connected to current location
  const currentLoc = getLocation(player.currentLocationId)
  if (!currentLoc?.connections.includes(locationId)) {
    res.json({ success: false, error: 'Cannot travel there from here' } satisfies ApiResponse<never>)
    return
  }

  const newLocation = movePlayer(locationId)
  if (!newLocation) {
    res.json({ success: false, error: 'Location not found' } satisfies ApiResponse<never>)
    return
  }

  const npcsHere = getNpcsAtLocation(locationId)

  res.json({
    success: true,
    data: { location: newLocation, npcs: npcsHere },
  })
})

worldRoutes.get('/npcs', (_req, res) => {
  if (!isGameActive()) {
    res.json({ success: false, error: 'No active game' } satisfies ApiResponse<never>)
    return
  }

  const player = getPlayer()
  const world = getWorld()

  // Only return NPCs the player has met
  const knownNpcs = world.npcs.filter((n) => player.knownNpcIds.includes(n.id))

  res.json({ success: true, data: knownNpcs })
})

worldRoutes.get('/npc/:id', (req, res) => {
  if (!isGameActive()) {
    res.json({ success: false, error: 'No active game' } satisfies ApiResponse<never>)
    return
  }

  const npc = getNpc(req.params.id)
  if (!npc) {
    res.json({ success: false, error: 'NPC not found' } satisfies ApiResponse<never>)
    return
  }

  // Return NPC info minus secrets and internal state
  const publicNpc = {
    id: npc.id,
    name: npc.name,
    age: npc.age,
    occupation: npc.occupation,
    appearance: npc.appearance,
    personality: { traits: npc.personality.traits, speechStyle: '', quirk: '' },
    mood: { current: npc.mood.current, toward_player: npc.mood.toward_player },
    currentLocationId: npc.currentLocationId,
  }

  res.json({ success: true, data: publicNpc })
})
