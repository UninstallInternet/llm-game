import { v4 as uuid } from 'uuid'
import { llmCall } from './client.js'
import { buildWorldGenPrompt } from './prompts.js'
import type {
  WorldState,
  NPC,
  Location,
  Faction,
  Mystery,
  Clue,
  WorldEvent,
  KnowledgeEntry,
  ScheduleEntry,
  TimeOfDay,
} from '../../shared/types.js'

type ProgressCallback = (phase: string, message: string) => void

interface RawWorldData {
  name: string
  locations: Array<{
    id: string
    name: string
    type: string
    description: string
    connections: string[]
    isPublic: boolean
    ownerId: string | null
  }>
  factions: Array<{
    id: string
    name: string
    description: string
    publicGoal: string
    secretGoal: string
  }>
  npcs: Array<{
    id: string
    name: string
    age: number
    occupation: string
    personality: { traits: string[]; speechStyle: string; quirk: string }
    appearance: string
    goals: { public: string; secret: string }
    secrets: string[]
    relationships: Array<{
      targetNpcId: string
      type: string
      trust?: number
      affection?: number
      respect?: number
      fear?: number
      strength?: number
      significantMemories?: string[]
      notes?: string
    }>
    factionId: string | null
    scheduleLocationIds: Record<string, string>
  }>
  mysteries: Array<{
    name: string
    description: string
    resolution: string
    clueNpcIds: string[]
    clueLocationIds: string[]
  }>
  events: Array<{
    type: string
    title: string
    description: string
    triggerDay: number
    triggerTime: string
    involvedNpcIds: string[]
    consequences: string[]
  }>
}

function parseJsonResponse(text: string): unknown {
  // Strip markdown code fences if present
  let cleaned = text.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  }
  return JSON.parse(cleaned)
}

export async function generateWorld(
  settingDescription: string,
  npcCount: number,
  locationCount: number,
  onProgress: ProgressCallback
): Promise<WorldState> {
  const worldId = uuid()

  onProgress('generating', `Creating world from: "${settingDescription}"...`)

  const prompt = buildWorldGenPrompt(settingDescription, npcCount, locationCount)

  let raw: RawWorldData | null = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const rawResponse = await llmCall('worldGen', prompt, 'Generate the world now.', true)
      onProgress('parsing', 'Parsing world data...')
      raw = parseJsonResponse(rawResponse) as RawWorldData
      break
    } catch (err) {
      if (attempt === 2) throw new Error(`World generation failed after 2 attempts: ${err instanceof Error ? err.message : 'unknown'}`)
      onProgress('retrying', `Generation incomplete, retrying (attempt ${attempt + 1})...`)
    }
  }
  if (!raw) throw new Error('World generation produced no data')

  // Transform raw data into proper WorldState
  onProgress('building', 'Building locations...')
  const locations: Location[] = raw.locations.map((loc) => ({
    id: loc.id,
    name: loc.name,
    type: loc.type,
    description: loc.description,
    connections: loc.connections,
    isPublic: loc.isPublic,
    ownerId: loc.ownerId,
  }))

  // Enforce bidirectional connections: if A -> B, then B -> A
  const locationIds = new Set(locations.map((l) => l.id))
  for (const loc of locations) {
    // Remove connections to non-existent locations
    loc.connections = loc.connections.filter((c) => locationIds.has(c))
    // Ensure reverse connections exist
    for (const connId of loc.connections) {
      const target = locations.find((l) => l.id === connId)
      if (target && !target.connections.includes(loc.id)) {
        target.connections.push(loc.id)
      }
    }
  }

  // Connect orphans (no connections at all) to first public location
  const firstPublicId = locations.find((l) => l.isPublic)?.id ?? locations[0]?.id
  for (const loc of locations) {
    if (loc.connections.length === 0 && firstPublicId && loc.id !== firstPublicId) {
      loc.connections.push(firstPublicId)
      const hub = locations.find((l) => l.id === firstPublicId)
      if (hub && !hub.connections.includes(loc.id)) {
        hub.connections.push(loc.id)
      }
    }
  }

  onProgress('building', 'Building factions...')
  const factions: Faction[] = raw.factions.map((f) => ({
    id: f.id,
    name: f.name,
    description: f.description,
    publicGoal: f.publicGoal,
    secretGoal: f.secretGoal,
    memberNpcIds: raw.npcs.filter((n) => n.factionId === f.id).map((n) => n.id),
  }))

  onProgress('building', `Bringing ${raw.npcs.length} characters to life...`)
  const validLocationIds = new Set(locations.map((l) => l.id))
  const firstLocationId = locations[0]?.id ?? 'loc_1'

  const npcs: NPC[] = raw.npcs.map((n) => {
    const schedule: ScheduleEntry[] = (['morning', 'afternoon', 'evening', 'night'] as TimeOfDay[]).map(
      (timeSlot) => {
        const locId = n.scheduleLocationIds?.[timeSlot]
        return {
          timeSlot,
          locationId: locId && validLocationIds.has(locId) ? locId : firstLocationId,
          activity: `${n.occupation} duties`,
        }
      }
    )

    // Start NPC at their morning location
    const startLocation = schedule.find((s) => s.timeSlot === 'morning')?.locationId ?? firstLocationId

    return {
      id: n.id,
      name: n.name,
      age: n.age,
      occupation: n.occupation,
      personality: n.personality,
      appearance: n.appearance,
      goals: n.goals,
      secrets: n.secrets,
      relationships: n.relationships.map((r) => {
        // Handle both old format (strength/notes) and new format (trust/affection/respect/fear)
        const strength = r.strength ?? 0
        return {
          targetNpcId: r.targetNpcId,
          type: r.type as NPC['relationships'][0]['type'],
          trust: r.trust ?? strength,
          affection: r.affection ?? Math.round(strength * 0.8),
          respect: r.respect ?? Math.round(Math.abs(strength) * 0.5),
          fear: r.fear ?? 0,
          significantMemories: r.significantMemories ?? (r.notes ? [r.notes] : []),
        }
      }),
      knowledge: [],
      mood: {
        current: 'neutral',
        toward_player: 0,
        reasons: [],
      },
      schedule,
      currentLocationId: startLocation,
      factionId: n.factionId,
    }
  })

  onProgress('building', 'Weaving mysteries...')
  const mysteries: Mystery[] = raw.mysteries.map((m) => ({
    id: uuid(),
    name: m.name,
    description: m.description,
    resolution: m.resolution,
    clues: [
      ...m.clueNpcIds.map(
        (npcId): Clue => ({
          id: uuid(),
          content: `${npcs.find((n) => n.id === npcId)?.name ?? 'Someone'} may know something about this.`,
          foundByPlayer: false,
          locationId: null,
          npcId,
        })
      ),
      ...m.clueLocationIds.map(
        (locId): Clue => ({
          id: uuid(),
          content: `There might be something to find at ${locations.find((l) => l.id === locId)?.name ?? 'somewhere'}.`,
          foundByPlayer: false,
          locationId: locId,
          npcId: null,
        })
      ),
    ],
    isResolved: false,
  }))

  onProgress('building', 'Setting up events...')
  const events: WorldEvent[] = raw.events.map((e) => ({
    id: uuid(),
    type: e.type as WorldEvent['type'],
    title: e.title,
    description: e.description,
    triggerDay: e.triggerDay,
    triggerTime: (e.triggerTime || 'morning') as TimeOfDay,
    resolved: false,
    involvedNpcIds: e.involvedNpcIds,
    consequences: e.consequences,
  }))

  // Give each NPC some initial knowledge about the world
  for (const npc of npcs) {
    const initialKnowledge: KnowledgeEntry[] = []

    // Know about their relationships
    for (const rel of npc.relationships) {
      const target = npcs.find((n) => n.id === rel.targetNpcId)
      if (target) {
        initialKnowledge.push({
          id: uuid(),
          content: `${target.name} is my ${rel.type}. ${rel.significantMemories?.[0] ?? ''}`,
          source: 'personal experience',
          confidence: 1.0,
          importance: 0.7,
          turnLearned: 0,
          isSecret: false,
        })
      }
    }

    // Know about their faction
    if (npc.factionId) {
      const faction = factions.find((f) => f.id === npc.factionId)
      if (faction) {
        initialKnowledge.push({
          id: uuid(),
          content: `I am part of ${faction.name}. ${faction.description}`,
          source: 'personal experience',
          confidence: 1.0,
          importance: 0.8,
          turnLearned: 0,
          isSecret: false,
        })
      }
    }

    npc.knowledge = initialKnowledge
  }

  const worldState: WorldState = {
    id: worldId,
    name: raw.name,
    settingDescription,
    currentTick: 0,
    time: { day: 1, timeOfDay: 'morning' },
    locations,
    npcs,
    factions,
    events,
    mysteries,
  }

  onProgress('complete', `${worldState.name} is ready! ${npcs.length} characters, ${locations.length} locations.`)

  return worldState
}
