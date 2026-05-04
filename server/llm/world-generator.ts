import { v4 as uuid } from 'uuid'
import { llmCall } from './client.js'
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

const OCCUPATION_TAG_MAP: Record<string, string[]> = {
  mechanic: ['mechanical-repair', 'tool-use', 'vehicle-knowledge'],
  blacksmith: ['metalwork', 'tool-use', 'forge-operation'],
  scientist: ['lab-equipment', 'data-analysis', 'chemical-handling'],
  doctor: ['medical-knowledge', 'first-aid', 'anatomy'],
  healer: ['medical-knowledge', 'herbalism', 'first-aid'],
  herbalist: ['herbalism', 'plant-knowledge', 'medicine'],
  guard: ['weapons', 'combat', 'surveillance'],
  soldier: ['weapons', 'combat', 'tactics'],
  sheriff: ['weapons', 'law-enforcement', 'investigation'],
  merchant: ['trade', 'negotiation', 'appraisal'],
  cook: ['cooking', 'food-preparation', 'knife-skills'],
  farmer: ['agriculture', 'animal-handling', 'weather-knowledge'],
  miner: ['excavation', 'geology', 'tool-use'],
  engineer: ['mechanical-repair', 'electrical', 'construction'],
  priest: ['religion', 'persuasion', 'literacy'],
  librarian: ['literacy', 'research', 'history'],
  spy: ['stealth', 'deception', 'investigation'],
  thief: ['stealth', 'lockpicking', 'agility'],
}

function deriveOccupationTags(occupation: string): string[] {
  const lower = occupation.toLowerCase()
  for (const [key, tags] of Object.entries(OCCUPATION_TAG_MAP)) {
    if (lower.includes(key)) return tags
  }
  return ['general-knowledge']
}

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
    tags?: string[]
    securityLevel?: number
    containers?: Array<{ name: string; tags?: string[]; searchDifficulty?: number; expectedItemTypes?: string[] }>
    fixtures?: string[]
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
    occupationTags?: string[]
    startingItems?: Array<{ name: string; tags: string[]; description: string }>
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

async function callLlm(
  tier: 'worldGen' | 'simulation',
  prompt: string,
  userMsg: string,
  onProgress: ProgressCallback,
  label: string
): Promise<unknown> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`[WorldGen:${label}] Attempt ${attempt}`)
      const raw = await llmCall(tier, prompt, userMsg, true)
      console.log(`[WorldGen:${label}] Response: ${raw.length} chars`)
      return parseJsonResponse(raw)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown'
      console.error(`[WorldGen:${label}] Attempt ${attempt} failed: ${msg}`)
      if (attempt === 2) throw new Error(`${label} failed: ${msg}`, { cause: err })
      onProgress('retrying', `${label} retry...`)
    }
  }
  throw new Error(`${label} produced no data`)
}

export async function generateWorld(
  settingDescription: string,
  npcCount: number,
  locationCount: number,
  onProgress: ProgressCallback
): Promise<WorldState> {
  const worldId = uuid()

  // ── Stage 1: Skeleton (gpt-4o) — locations, factions, mystery, events ──
  onProgress('generating', 'Creating world skeleton...')

  const skeletonPrompt = `You are a world builder for a text adventure. Generate the SKELETON of a settlement — locations, factions, a mystery, and events. DO NOT generate NPCs yet.

SETTING: ${settingDescription}
Generate EXACTLY ${locationCount} locations.

Each location needs: id (loc_1, loc_2...), name, type, description (2-3 sentences), connections (bidirectional), isPublic, ownerId (null for now), tags, securityLevel (0-5), containers (searchable spots with expectedItemTypes — generate 2-3 per location), fixtures (immovable features), and initialItems (2-3 items already visible on the ground — tools, documents, materials appropriate for the location type).

Generate 2-3 factions, 1 mystery with clues, and 3-5 timed events.

Respond with ONLY JSON:
{
  "name": "Settlement name",
  "locations": [{ "id": "loc_1", "name": "...", "type": "...", "description": "...", "connections": ["loc_2"], "isPublic": true, "ownerId": null, "tags": ["indoor"], "securityLevel": 0, "containers": [{"name": "tool chest", "expectedItemTypes": ["tools"], "searchDifficulty": 1}], "fixtures": ["workbench"], "initialItems": [{"name": "wrench", "tags": ["tool"], "description": "A heavy adjustable wrench"}] }],
  "factions": [{ "id": "faction_1", "name": "...", "description": "...", "publicGoal": "...", "secretGoal": "..." }],
  "mysteries": [{ "name": "...", "description": "...", "resolution": "...", "clueLocationIds": ["loc_1"] }],
  "events": [{ "type": "crisis", "title": "...", "description": "...", "triggerDay": 2, "triggerTime": "morning", "involvedNpcIds": [], "consequences": ["..."] }]
}`

  const skeleton = await callLlm('worldGen', skeletonPrompt, 'Generate the world skeleton.', onProgress, 'Skeleton') as {
    name: string
    locations: RawWorldData['locations']
    factions: RawWorldData['factions']
    mysteries: RawWorldData['mysteries']
    events: RawWorldData['events']
  }

  onProgress('building', `${skeleton.name} — ${skeleton.locations?.length ?? 0} locations created`)

  // ── Stage 2: NPCs in batches (gpt-4o-mini) ──
  const locationList = (skeleton.locations ?? []).map((l) => `${l.id}: ${l.name} (${l.type})`).join(', ')
  const factionList = (skeleton.factions ?? []).map((f) => `${f.id}: ${f.name}`).join(', ')
  const mysteryDesc = (skeleton.mysteries ?? []).map((m) => m.name).join(', ')

  const allNpcs: RawWorldData['npcs'] = []
  const batchSize = 5
  const batches = Math.ceil(npcCount / batchSize)

  for (let batch = 0; batch < batches; batch++) {
    const remaining = npcCount - allNpcs.length
    const count = Math.min(batchSize, remaining)
    const startId = allNpcs.length + 1

    onProgress('generating', `Creating characters ${allNpcs.length + 1}-${allNpcs.length + count} of ${npcCount}...`)

    const existingNpcs = allNpcs.map((n) => `${n.id}: ${n.name} (${n.occupation}, faction: ${n.factionId ?? 'none'})`).join('\n')

    const npcPrompt = `Generate ${count} NPCs for a text adventure set in "${skeleton.name}". Setting: ${settingDescription}

Locations: ${locationList}
Factions: ${factionList}
Mystery: ${mysteryDesc}
${existingNpcs ? `Existing NPCs (create relationships with these):\n${existingNpcs}` : ''}

NPC IDs should start at npc_${startId}. Each NPC needs:
- Unique name, age, occupation, personality (traits, speechStyle, quirk), appearance
- Public goal + secret goal (secret must conflict with another NPC)
- 1-2 secrets, relationships with existing NPCs (trust/affection/respect/fear/significantMemories)
- Faction assignment (or null), schedule across locations
- Every NPC MUST have a SECRET GOAL that creates tension
- Give each NPC 1-2 startingItems based on their occupation (mechanic has tools, scientist has lab equipment, guard has weapon, etc.)

Respond with ONLY JSON:
{
  "npcs": [{
    "id": "npc_${startId}", "name": "...", "age": 35, "occupation": "...",
    "personality": { "traits": ["..."], "speechStyle": "...", "quirk": "..." },
    "appearance": "...",
    "goals": { "public": "...", "secret": "..." },
    "secrets": ["..."],
    "relationships": [{ "targetNpcId": "npc_X", "type": "friend", "trust": 50, "affection": 30, "respect": 40, "fear": 0, "significantMemories": ["..."] }],
    "factionId": "faction_1" or null,
    "scheduleLocationIds": { "morning": "loc_1", "afternoon": "loc_2", "evening": "loc_1", "night": "loc_1" }
  }]
}`

    const batchResult = await callLlm('simulation', npcPrompt, `Generate NPCs ${startId}-${startId + count - 1}.`, onProgress, `NPCs batch ${batch + 1}`) as { npcs: RawWorldData['npcs'] }
    allNpcs.push(...(batchResult.npcs ?? []))

    console.log(`[WorldGen] Batch ${batch + 1}: ${batchResult.npcs?.length ?? 0} NPCs (total: ${allNpcs.length})`)
  }

  // Update mystery clueNpcIds now that we have NPCs
  for (const mystery of skeleton.mysteries ?? []) {
    if (!mystery.clueNpcIds || mystery.clueNpcIds.length === 0) {
      mystery.clueNpcIds = allNpcs.slice(0, 2).map((n) => n.id)
    }
  }

  // Assemble raw data
  const raw: RawWorldData = {
    name: skeleton.name,
    locations: skeleton.locations ?? [],
    factions: skeleton.factions ?? [],
    npcs: allNpcs,
    mysteries: skeleton.mysteries ?? [],
    events: skeleton.events ?? [],
  }

  onProgress('building', `Assembling ${raw.npcs.length} characters in ${raw.locations.length} locations...`)

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
    tags: loc.tags ?? [loc.type],
    securityLevel: loc.securityLevel ?? 0,
    containers: (loc.containers ?? []).map((c, i) => ({
      id: `${loc.id}_cont_${i}`,
      name: c.name,
      tags: c.tags ?? [],
      searchDifficulty: c.searchDifficulty ?? 1,
      searchCount: 0,
      lastSearchTick: 0,
      expectedItemTypes: c.expectedItemTypes ?? [],
    })),
    fixtures: loc.fixtures ?? [],
    items: ((loc as unknown as { initialItems?: Array<{ name: string; tags: string[]; description: string }> }).initialItems ?? []).map((item, i) => ({
      id: `${loc.id}_item_${i}`,
      name: item.name,
      tags: item.tags ?? [],
      locationId: loc.id,
      ownerId: null,
      description: item.description ?? '',
    })),
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

  // Add shops to locations that would plausibly sell things
  const settingLower = settingDescription.toLowerCase()
  const currencyName = settingLower.includes('gold') || settingLower.includes('medieval') || settingLower.includes('fantasy') ? 'gold'
    : settingLower.includes('credit') || settingLower.includes('space') || settingLower.includes('future') ? 'credits'
    : settingLower.includes('dollar') || settingLower.includes('western') ? 'dollars'
    : 'coins'

  // Location types/names that would have things for sale
  const shopTypes = new Set(['market', 'store', 'shop', 'tavern', 'saloon', 'bar', 'inn'])
  const shopNameWords = ['store', 'shop', 'market', 'bazaar', 'trading', 'goods', 'merchant', 'vendor', 'tavern', 'saloon', 'bar', 'inn', 'pub', 'cantina', 'lounge', 'apothecary', 'armory', 'smithy', 'forge']

  // Setting-appropriate item sets
  const tavernItems = [
    { item: { id: '', name: 'Flask of Spirits', tags: ['drink', 'consumable'], locationId: null, ownerId: null, description: 'Strong drink. Loosens tongues and steadies nerves.' }, price: 5, stock: 10 },
    { item: { id: '', name: 'Hearty Meal', tags: ['food', 'consumable'], locationId: null, ownerId: null, description: 'A warm meal that restores energy.' }, price: 8, stock: 5 },
    { item: { id: '', name: 'Healing Tonic', tags: ['medicine', 'consumable'], locationId: null, ownerId: null, description: 'Bitter brew that mends minor wounds.' }, price: 15, stock: 3 },
  ]
  const generalItems = [
    { item: { id: '', name: 'Healing Salve', tags: ['medicine', 'consumable'], locationId: null, ownerId: null, description: 'Medicinal paste for wounds.' }, price: 15, stock: 3 },
    { item: { id: '', name: 'Sturdy Rope', tags: ['tool', 'general'], locationId: null, ownerId: null, description: 'Strong rope, many uses.' }, price: 8, stock: 5 },
    { item: { id: '', name: 'Lantern', tags: ['tool', 'light'], locationId: null, ownerId: null, description: 'Oil lantern for dark places.' }, price: 12, stock: 3 },
    { item: { id: '', name: 'Lockpick Set', tags: ['tool', 'stealth'], locationId: null, ownerId: null, description: 'Fine picks for opening locks.' }, price: 25, stock: 2 },
    { item: { id: '', name: 'Flask of Spirits', tags: ['drink', 'consumable'], locationId: null, ownerId: null, description: 'Strong drink.' }, price: 5, stock: 10 },
  ]
  const armoryItems = [
    { item: { id: '', name: 'Short Sword', tags: ['weapon', 'melee'], locationId: null, ownerId: null, description: 'A reliable blade for close combat.' }, price: 30, stock: 2 },
    { item: { id: '', name: 'Leather Armor', tags: ['armor', 'clothing'], locationId: null, ownerId: null, description: 'Basic protection without slowing you down.' }, price: 25, stock: 2 },
    { item: { id: '', name: 'Healing Salve', tags: ['medicine', 'consumable'], locationId: null, ownerId: null, description: 'Medicinal paste for battle wounds.' }, price: 15, stock: 3 },
  ]

  let shopAdded = false
  for (const loc of locations) {
    const nameLower = loc.name.toLowerCase()
    const isShopLocation = shopTypes.has(loc.type) || shopNameWords.some((w) => nameLower.includes(w))
    if (!isShopLocation) continue

    // Pick items based on location type
    const isTavern = ['tavern', 'saloon', 'bar', 'inn', 'pub', 'cantina', 'lounge'].some((w) => nameLower.includes(w) || loc.type === w)
    const isArmory = ['armory', 'smithy', 'forge', 'weapon'].some((w) => nameLower.includes(w))
    const baseItems = isArmory ? armoryItems : isTavern ? tavernItems : generalItems

    const shopItems = baseItems.map((si, i) => ({
      ...si,
      item: { ...si.item, id: `${loc.id}_shop_${i}` },
    }))

    loc.containers.push({
      id: `${loc.id}_shop`,
      name: isTavern ? 'bar menu' : isArmory ? 'weapons rack' : `${loc.name} counter`,
      tags: ['shop'],
      searchDifficulty: 0,
      searchCount: 0,
      lastSearchTick: 0,
      expectedItemTypes: ['general'],
      isShop: true,
      shopInventory: shopItems,
      currencyName,
    })
    shopAdded = true
  }

  // Guarantee at least one shop — pick the most "public" location
  if (!shopAdded) {
    const publicLoc = locations.find((l) => l.isPublic) ?? locations[0]
    if (publicLoc) {
      const shopItems = generalItems.map((si, i) => ({
        ...si,
        item: { ...si.item, id: `${publicLoc.id}_shop_${i}` },
      }))
      publicLoc.containers.push({
        id: `${publicLoc.id}_shop`,
        name: 'trading post',
        tags: ['shop'],
        searchDifficulty: 0,
        searchCount: 0,
        lastSearchTick: 0,
        expectedItemTypes: ['general'],
        isShop: true,
        shopInventory: shopItems,
        currencyName,
      })
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
      beliefs: [],
      mood: {
        current: 'neutral',
        toward_player: 0,
        reasons: [],
      },
      schedule,
      currentLocationId: startLocation,
      factionId: n.factionId,
      occupationTags: n.occupationTags ?? deriveOccupationTags(n.occupation),
      inventory: (n.startingItems ?? []).map((item, i) => ({
        id: `${n.id}_item_${i}`,
        name: item.name,
        tags: item.tags,
        locationId: null,
        ownerId: n.id,
        description: item.description,
      })),
      activePlan: null,
      physical: { health: 100, energy: 100, injuries: [], status: 'alive' as const },
      stateFlags: [],
      agreements: [],
      scheduledMeetings: [],
      npcDialogueHistory: {},
      currency: Math.floor(20 + Math.random() * 80),
      portraitUrl: null,
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
    time: { day: 1, timeOfDay: 'morning', hour: 8, minute: 0 },
    locations,
    npcs,
    factions,
    events,
    mysteries,
  }

  // Generate portraits in parallel (non-blocking, opt-in via ENABLE_PORTRAITS env)
  if (process.env.ENABLE_PORTRAITS === 'true') {
    onProgress('generating', 'Creating character portraits...')
    try {
      const { generatePortraitBatch } = await import('./portrait-generator.js')
      const portraits = await generatePortraitBatch(npcs, settingDescription)
      for (const [npcId, url] of portraits) {
        const npc = npcs.find((n) => n.id === npcId)
        if (npc) npc.portraitUrl = url
      }
      onProgress('generating', `Generated ${portraits.size} portraits.`)
    } catch (err) {
      console.error('[Portraits] Batch generation failed:', err)
    }
  }

  onProgress('complete', `${worldState.name} is ready! ${npcs.length} characters, ${locations.length} locations.`)

  return worldState
}
