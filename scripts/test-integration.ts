import 'dotenv/config'

const BASE = 'http://localhost:3001'
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

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return res.json()
}

async function main() {
  console.log('=== LLM Game Integration Tests ===\n')

  // Test 1: Health check
  console.log('1. Server health')
  const health = await api('GET', '/api/health')
  assert(health.status === 'ok', 'Server responds OK')

  // Test 2: World generation
  console.log('\n2. World generation')
  const gen = await api('POST', '/api/game/new', {
    settingDescription: 'Small test village. Mystery.',
    npcCount: 3,
    locationCount: 3,
  }) as { success: boolean; data?: { world: { name: string; npcs: unknown[]; locations: unknown[]; currentTick: number }; player: { physical?: { health: number }; inventory: unknown[] } } }
  assert(gen.success === true, 'World generated successfully')
  assert(gen.data!.world.npcs.length >= 2, `NPCs created: ${gen.data!.world.npcs.length}`)
  assert(gen.data!.world.locations.length >= 2, `Locations created: ${gen.data!.world.locations.length}`)

  // Test 3: Game state
  console.log('\n3. Game state')
  const state = await api('GET', '/api/game/state') as { success: boolean; data?: { world: { name: string; npcs: Array<{ id: string; name: string; currentLocationId: string; knowledge: unknown[]; activePlan: unknown; mood: { toward_player: number }; agreements: unknown[] }>; locations: Array<{ id: string; connections: string[] }> }; player: { currentLocationId: string; conversationHistory: Record<string, unknown[]> } } }
  assert(state.success === true, 'State loads')
  assert(state.data!.world.name.length > 0, `World name: ${state.data!.world.name}`)

  // Test 4: Chat with NPC
  console.log('\n4. Chat with NPC')
  const npc = state.data!.world.npcs.find((n) => n.currentLocationId === state.data!.player.currentLocationId)
  if (npc) {
    // Move to NPC location if needed
    const chat = await api('POST', '/api/chat', {
      npcId: npc.id,
      message: 'Hello, my name is Tester. What is happening here?',
    }) as { success: boolean; data?: { dialogue: string; debug?: { knowledgeGained?: unknown[]; internalThought?: string } } }
    assert(chat.success === true, 'Chat succeeds')
    assert(chat.data!.dialogue.length > 10, 'NPC gives real dialogue')
    assert(!!chat.data!.debug?.internalThought, 'Internal thought captured')
    assert(Array.isArray(chat.data!.debug?.knowledgeGained) && (chat.data!.debug?.knowledgeGained?.length ?? 0) > 0, 'Knowledge gained from chat')
  } else {
    console.log('  SKIP: No NPC at player location')
  }

  // Test 5: NPC remembers the chat
  console.log('\n5. Memory persistence')
  const state2 = await api('GET', '/api/game/state') as typeof state
  if (npc) {
    const npcAfter = state2.data!.world.npcs.find((n) => n.id === npc.id)!
    const playerK = npcAfter.knowledge.filter((k: { source?: string }) => (k as { source: string }).source?.toLowerCase().includes('visitor') || (k as { source: string }).source?.toLowerCase().includes('player') || (k as { source: string }).source?.toLowerCase().includes('tester'))
    assert(playerK.length > 0, `NPC remembers player: ${playerK.length} entries`)
  }

  // Test 6: Player action
  console.log('\n6. Player actions')
  const action = await api('POST', '/api/action', { action: 'search the room carefully' }) as { success: boolean; data?: { outcome: string; narrative: string } }
  assert(action.success === true, 'Action succeeds')
  assert(['strong_success', 'partial_success', 'failure'].includes(action.data!.outcome), `Outcome: ${action.data!.outcome}`)

  // Test 7: Tick advancement
  console.log('\n7. Tick advancement')
  const before = (await api('GET', '/api/game/state') as typeof state).data!.world.currentTick
  await api('POST', '/api/action', { action: 'wait' })
  await api('POST', '/api/action', { action: 'wait' })
  // Wait for async tick (LLM calls can take 30s+)
  await new Promise((r) => setTimeout(r, 30000))
  const after = (await api('GET', '/api/game/state') as typeof state).data!.world.currentTick
  assert(after > before, `Tick advanced: ${before} → ${after}`)

  // Test 8: NPC plans form
  console.log('\n8. NPC plan formation')
  const state3 = await api('GET', '/api/game/state') as typeof state
  const withPlans = state3.data!.world.npcs.filter((n) => n.activePlan)
  assert(withPlans.length > 0, `NPCs with plans: ${withPlans.length}/${state3.data!.world.npcs.length}`)

  // Test 9: Navigation
  console.log('\n9. Navigation')
  const currentLoc = state3.data!.world.locations.find((l) => l.id === state3.data!.player.currentLocationId)!
  if (currentLoc.connections.length > 0) {
    const move = await api('POST', '/api/world/move', { locationId: currentLoc.connections[0] }) as { success: boolean }
    assert(move.success === true, 'Navigation succeeds')
    const moved = await api('POST', '/api/world/move', { locationId: currentLoc.id }) as { success: boolean }
    assert(moved.success === true, 'Can return to original location')
  }

  // Test 10: Save/load
  console.log('\n10. Save and load')
  await api('POST', '/api/game/save')
  const saves = await api('GET', '/api/game/saves') as { success: boolean; data?: Array<{ id: string; name: string }> }
  assert(saves.success === true && (saves.data?.length ?? 0) > 0, `Saves exist: ${saves.data?.length}`)

  // Test 11: Agreement dedup
  console.log('\n11. Agreement dedup')
  if (npc) {
    await api('POST', '/api/chat', { npcId: npc.id, message: 'Lets agree to work together on this mystery.' })
    await api('POST', '/api/chat', { npcId: npc.id, message: 'So we agreed to work together on the mystery right?' })
    await api('POST', '/api/chat', { npcId: npc.id, message: 'Confirming our agreement to work together on the mystery.' })
    await new Promise((r) => setTimeout(r, 5000))
    const state4 = await api('GET', '/api/game/state') as typeof state
    const npcFinal = state4.data!.world.npcs.find((n) => n.id === npc.id)!
    const agreements = npcFinal.agreements?.filter((a: { active?: boolean }) => a.active) ?? []
    assert(agreements.length <= 3, `Agreement dedup: ${agreements.length} active (should be ≤3, not 9+)`)
  }

  // Test 12: Memory dedup
  console.log('\n12. Memory dedup')
  if (npc) {
    const state5 = await api('GET', '/api/game/state') as typeof state
    const npcMem = state5.data!.world.npcs.find((n) => n.id === npc.id)!
    const contents = npcMem.knowledge.map((k: { content?: string }) => (k as { content: string }).content?.slice(0, 30))
    const unique = new Set(contents)
    const dupRate = 1 - unique.size / contents.length
    assert(dupRate < 0.3, `Memory dedup: ${(dupRate * 100).toFixed(0)}% duplicate (should be <30%)`)
  }

  // Summary
  console.log(`\n${'='.repeat(40)}`)
  console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error('Test runner error:', e)
  process.exit(1)
})
