/**
 * Smoke tests — no API key required, no LLM calls, free to run.
 * Validates core game logic: state management, validation, memory scoring.
 *
 * Usage: npm run test:smoke
 */

import { v4 as uuid } from 'uuid'
import type { NPC, WorldState, Player, KnowledgeEntry } from '../shared/types.js'

let passed = 0
let failed = 0

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  PASS: ${msg}`)
    passed++
  } else {
    console.log(`  FAIL: ${msg}`)
    failed++
  }
}

// ─── Test fixtures ───

function makeNpc(overrides: Partial<NPC> = {}): NPC {
  return {
    id: uuid(),
    name: 'Test NPC',
    occupation: 'merchant',
    occupationTags: ['trade', 'commerce'],
    personality: 'friendly',
    secret: 'has a hidden stash',
    currentLocationId: 'loc_1',
    schedule: [],
    knowledge: [],
    beliefs: [],
    relationships: [],
    mood: { current: 'neutral', toward_player: 0, reasons: [] },
    inventory: [],
    activePlan: null,
    physical: { health: 100, energy: 100, injuries: [], status: 'alive' },
    stateFlags: [],
    agreements: [],
    scheduledMeetings: [],
    npcDialogueHistory: {},
    currency: 50,
    portraitUrl: null,
    ...overrides,
  }
}

function makeWorld(overrides: Partial<WorldState> = {}): WorldState {
  return {
    id: uuid(),
    name: 'Test World',
    settingDescription: 'A test world',
    locations: [{
      id: 'loc_1',
      name: 'Town Square',
      description: 'The center of town',
      type: 'public',
      tags: ['public', 'outdoor'],
      connections: ['loc_2'],
      isPublic: true,
      npcs: [],
      containers: [{
        id: 'cont_1',
        name: 'Old Crate',
        description: 'A wooden crate',
        searchDifficulty: 3,
        expectedItemTypes: ['tools', 'supplies'],
        searchCount: 0,
        lastSearchTick: 0,
      }],
      fixtures: [],
      items: [],
      securityLevel: 0,
    }, {
      id: 'loc_2',
      name: 'Tavern',
      description: 'A cozy tavern',
      type: 'business',
      tags: ['indoor', 'social'],
      connections: ['loc_1'],
      isPublic: true,
      npcs: [],
      containers: [],
      fixtures: [],
      items: [],
      securityLevel: 0,
    }],
    npcs: [makeNpc()],
    factions: [],
    mysteries: [{
      id: 'mys_1',
      description: 'A test mystery',
      isResolved: false,
      clues: [{ description: 'A clue', locationId: 'loc_1', npcId: '', foundByPlayer: false }],
    }],
    events: [
      { type: 'scheduled', title: 'Test Event', description: 'Something happens', triggerDay: 1, triggerTime: 'morning', resolved: false, involvedNpcIds: [], consequences: [] },
    ],
    currentTick: 0,
    time: { day: 1, timeOfDay: 'morning', hour: 8, minute: 0 },
    ...overrides,
  } as WorldState
}

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    currentLocationId: 'loc_1',
    knownNpcIds: [],
    knownLocationIds: ['loc_1'],
    notes: [],
    conversationHistory: {},
    inventory: [],
    physical: { health: 100, energy: 100, injuries: [], status: 'alive' },
    actionLog: [],
    currency: 50,
    ...overrides,
  }
}

// ─── Tests ───

async function main() {
  console.log('=== Smoke Tests (no API key required) ===\n')

  // 1. TypeScript compilation (already verified by running this file)
  console.log('1. TypeScript compilation')
  assert(true, 'File compiles and runs')

  // 2. State management imports
  console.log('\n2. State management')
  const state = await import('../server/game/state.js')
  assert(typeof state.setWorldAndPlayer === 'function', 'setWorldAndPlayer exists')
  assert(typeof state.getWorld === 'function', 'getWorld exists')
  assert(typeof state.addNpcKnowledge === 'function', 'addNpcKnowledge exists')
  assert(typeof state.addNpcInventoryItem === 'function', 'addNpcInventoryItem exists')
  assert(typeof state.addLocationItem === 'function', 'addLocationItem exists')
  assert(typeof state.markEventResolved === 'function', 'markEventResolved exists')
  assert(typeof state.updateContainerSearchTracking === 'function', 'updateContainerSearchTracking exists')
  assert(typeof state.updateNpcBeliefs === 'function', 'updateNpcBeliefs exists')

  // 3. Set up a world and verify state
  console.log('\n3. State initialization')
  const world = makeWorld()
  const player = makePlayer()
  state.setWorldAndPlayer(world, player)

  const loaded = state.getWorld()
  assert(loaded.name === 'Test World', 'World name matches')
  assert(loaded.npcs.length === 1, 'NPC count matches')
  assert(loaded.locations.length === 2, 'Location count matches')

  const loadedPlayer = state.getPlayer()
  assert(loadedPlayer.currentLocationId === 'loc_1', 'Player location matches')
  assert(loadedPlayer.currency === 50, 'Player currency matches')

  // 4. NPC state operations
  console.log('\n4. NPC state operations')
  const npcId = loaded.npcs[0].id

  // Knowledge
  state.addNpcKnowledge(npcId, [{
    id: uuid(),
    content: 'The merchant sells weapons and armor at the market square every morning',
    source: 'observed',
    confidence: 1.0,
    importance: 0.5,
    turnLearned: 0,
    isSecret: false,
  }])
  const afterK = state.getNpc(npcId)!
  assert(afterK.knowledge.length === 1, 'Knowledge added')
  assert(afterK.knowledge[0].content.includes('merchant'), 'Knowledge content correct')

  // Dedup — first 40 chars match triggers dedup
  state.addNpcKnowledge(npcId, [{
    id: uuid(),
    content: 'The merchant sells weapons and armor at the market square every morning and afternoon now',
    source: 'observed',
    confidence: 1.0,
    importance: 0.7,
    turnLearned: 1,
    isSecret: false,
  }])
  const afterK2 = state.getNpc(npcId)!
  assert(afterK2.knowledge.length === 1, `Knowledge deduped: ${afterK2.knowledge.length} (expected 1)`)
  assert(afterK2.knowledge[0].importance === 0.7, 'Importance updated to higher value')

  // Mood
  state.updateNpcMood(npcId, 'happy', 5, 'had a good chat')
  const afterMood = state.getNpc(npcId)!
  assert(afterMood.mood.current === 'happy', 'Mood updated')
  assert(afterMood.mood.toward_player === 5, 'Player disposition updated')

  // Relationships
  const otherNpcId = 'npc_other'
  state.updateNpcRelationship(npcId, otherNpcId, { trust: 10, respect: 5 }, 'Met at the tavern')
  const afterRel = state.getNpc(npcId)!
  const rel = afterRel.relationships.find((r) => r.targetNpcId === otherNpcId)
  assert(!!rel, 'Relationship created')
  assert(rel!.trust === 10, 'Trust set correctly')
  assert(rel!.respect === 5, 'Respect set correctly')

  // State flags
  state.updateNpcStateFlags(npcId, ['add:injured', 'add:determined'])
  const afterFlags = state.getNpc(npcId)!
  assert(afterFlags.stateFlags.includes('injured'), 'Tag added: injured')
  assert(afterFlags.stateFlags.includes('determined'), 'Tag added: determined')

  state.updateNpcStateFlags(npcId, ['remove:determined'])
  const afterRemove = state.getNpc(npcId)!
  assert(!afterRemove.stateFlags.includes('determined'), 'Tag removed: determined')
  assert(afterRemove.stateFlags.includes('injured'), 'Other tag preserved')

  // Inventory (via state layer)
  state.addNpcInventoryItem(npcId, {
    id: 'item_test',
    name: 'Test Sword',
    tags: ['weapon'],
    locationId: null as unknown as string,
    ownerId: npcId,
    description: 'A test sword',
  })
  const afterInv = state.getNpc(npcId)!
  assert(afterInv.inventory.length === 1, 'Item added to inventory')
  assert(afterInv.inventory[0].name === 'Test Sword', 'Item name correct')

  // 5. Location operations
  console.log('\n5. Location operations')
  state.addLocationItem('loc_1', {
    id: 'item_ground',
    name: 'Dropped Coin',
    tags: ['currency'],
    locationId: 'loc_1',
    ownerId: null as unknown as string,
    description: 'A coin on the ground',
  })
  const loc = state.getLocation('loc_1')!
  assert(loc.items.length === 1, 'Item added to location')

  // Container search tracking
  state.updateContainerSearchTracking('loc_1', 'cont_1', 1, 5)
  const locAfterSearch = state.getLocation('loc_1')!
  const cont = locAfterSearch.containers.find((c) => c.id === 'cont_1')!
  assert(cont.searchCount === 1, 'Search count updated')
  assert(cont.lastSearchTick === 5, 'Last search tick updated')

  // 6. Event system
  console.log('\n6. Event system')
  state.markEventResolved(0)
  const worldAfterEvent = state.getWorld()
  assert(worldAfterEvent.events[0].resolved === true, 'Event marked resolved')

  // 7. Mystery clues
  console.log('\n7. Mystery clues')
  state.markMysteryClueFound(0, 0)
  const worldAfterClue = state.getWorld()
  assert(worldAfterClue.mysteries[0].clues[0].foundByPlayer === true, 'Mystery clue marked found')

  // 8. NPC beliefs (via state layer)
  console.log('\n8. NPC beliefs')
  state.updateNpcBeliefs(npcId, [{
    proposition: 'The mayor is corrupt',
    source: 'npc_other',
    confidence: 0.7,
    corroboratedBy: [],
    contradictedBy: [],
    tick: 1,
  }])
  const afterBelief = state.getNpc(npcId)!
  assert(afterBelief.beliefs.length === 1, 'Belief added')
  assert(afterBelief.beliefs[0].proposition === 'The mayor is corrupt', 'Belief content correct')

  // 9. Movement
  console.log('\n9. Movement')
  state.moveNpc(npcId, 'loc_2')
  const movedNpc = state.getNpc(npcId)!
  assert(movedNpc.currentLocationId === 'loc_2', 'NPC moved to loc_2')

  const playerLoc = state.movePlayer('loc_2')
  assert(playerLoc?.id === 'loc_2', 'Player moved to loc_2')
  assert(state.getPlayer().knownLocationIds.includes('loc_2'), 'New location added to known')

  // 10. Memory scoring
  console.log('\n10. Memory scoring')
  // Add varied knowledge for scoring test
  const memories: KnowledgeEntry[] = [
    { id: uuid(), content: 'The tavern serves great ale', source: 'observed', confidence: 1.0, importance: 0.3, turnLearned: 0, isSecret: false },
    { id: uuid(), content: 'The mayor has a secret tunnel under the hall', source: 'overheard', confidence: 0.8, importance: 0.9, turnLearned: 5, isSecret: true },
    { id: uuid(), content: 'Rain is expected tomorrow', source: 'observed', confidence: 1.0, importance: 0.1, turnLearned: 1, isSecret: false },
  ]
  // Reset knowledge and add test data
  state.updateNpcBeliefs(npcId, []) // clear beliefs to not interfere
  const freshNpc = makeNpc({ id: 'npc_mem_test' })
  const freshWorld = makeWorld({ npcs: [freshNpc] })
  state.setWorldAndPlayer(freshWorld, makePlayer())
  for (const m of memories) {
    state.addNpcKnowledge('npc_mem_test', [m])
  }

  const top = state.getTopMemories(state.getNpc('npc_mem_test')!, 10, 'mayor secret tunnel')
  assert(top.length === 3, 'All memories returned')
  assert(top[0].content.includes('mayor'), 'Most relevant memory first (context: mayor)')

  // 11. Time advancement
  console.log('\n11. Time advancement')
  const timeBefore = state.getWorld().time
  state.advanceTime()
  const timeAfter = state.getWorld().time
  assert(timeAfter.minute === timeBefore.minute + 10 || (timeBefore.minute >= 50 && timeAfter.hour === timeBefore.hour + 1), 'Time advances by 10 minutes')
  assert(state.getWorld().currentTick === 1, 'Tick incremented')

  // 12. Agreements
  console.log('\n12. Agreements')
  state.addNpcAgreement('npc_mem_test', 'npc_other', 'We will meet at the tavern at noon', 1)
  const afterAgr = state.getNpc('npc_mem_test')!
  assert(afterAgr.agreements.length === 1, 'Agreement added')
  assert(afterAgr.agreements[0].active === true, 'Agreement is active')

  // Dedup similar agreement (keyword overlap >= 3 or >50% triggers dedup)
  state.addNpcAgreement('npc_mem_test', 'npc_other', 'We will meet at the tavern at noon for sure', 2)
  const afterAgr2 = state.getNpc('npc_mem_test')!
  assert(afterAgr2.agreements.length === 1, `Agreement deduped: ${afterAgr2.agreements.length} (expected 1)`)

  // 13. Physical effects
  console.log('\n13. Physical effects')
  state.applyPhysicalEffects('npc_mem_test', { healthDelta: -30, injury: 'sword wound' })
  const afterDmg = state.getNpc('npc_mem_test')!
  assert(afterDmg.physical.health === 70, `Health reduced: ${afterDmg.physical.health}`)
  assert(afterDmg.physical.injuries.includes('sword wound'), 'Injury recorded')

  state.applyPhysicalEffects('npc_mem_test', { healthDelta: -60 })
  const afterKO = state.getNpc('npc_mem_test')!
  assert(afterKO.physical.health === 10, `Health at ${afterKO.physical.health}`)
  assert(afterKO.physical.status === 'unconscious', 'Status becomes unconscious at low HP')

  // 14. Validation schemas
  console.log('\n14. Validation schemas')
  const { playerActionSchema, chatRequestSchema, generateWorldSchema } = await import('../server/middleware/validate.js')

  const validAction = playerActionSchema.safeParse({ action: 'search the room' })
  assert(validAction.success, 'Valid action passes')

  const emptyAction = playerActionSchema.safeParse({ action: '' })
  assert(!emptyAction.success, 'Empty action rejected')

  const longAction = playerActionSchema.safeParse({ action: 'a'.repeat(501) })
  assert(!longAction.success, 'Too-long action rejected')

  const validChat = chatRequestSchema.safeParse({ npcId: 'npc_1', message: 'Hello' })
  assert(validChat.success, 'Valid chat passes')

  const noMessage = chatRequestSchema.safeParse({ npcId: 'npc_1', message: '' })
  assert(!noMessage.success, 'Empty message rejected')

  const validWorld = generateWorldSchema.safeParse({ settingDescription: 'A village', npcCount: 5, locationCount: 3 })
  assert(validWorld.success, 'Valid world gen passes')

  const tooManyNpcs = generateWorldSchema.safeParse({ settingDescription: 'A village', npcCount: 100 })
  assert(!tooManyNpcs.success, 'Too many NPCs rejected')

  // 15. Busy NPC tracking
  console.log('\n15. Busy NPC tracking')
  state.markNpcBusy('npc_mem_test')
  assert(state.isNpcBusy('npc_mem_test'), 'NPC marked busy')
  state.markNpcFree('npc_mem_test')
  assert(!state.isNpcBusy('npc_mem_test'), 'NPC marked free')

  // 16. Tag cap enforcement
  console.log('\n16. Tag cap (max 7)')
  state.updateNpcStateFlags('npc_mem_test', [
    'add:angry', 'add:scared', 'add:drunk', 'add:confident',
    'add:suspicious', 'add:excited', 'add:focused', 'add:depressed',
  ])
  const afterTagCap = state.getNpc('npc_mem_test')!
  assert(afterTagCap.stateFlags.length <= 7, `Tags capped: ${afterTagCap.stateFlags.length} (max 7)`)

  // Summary
  console.log(`\n${'='.repeat(40)}`)
  console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`)
  console.log('Cost: $0.00 (no LLM calls)')
  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error('Test runner error:', e)
  process.exit(1)
})
