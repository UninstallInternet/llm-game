import 'dotenv/config'

const BASE = 'http://localhost:3001'

async function main() {
  const setting = process.argv[2] ?? 'A small medieval village with a tavern, blacksmith, and church. The village elder just died mysteriously.'
  const npcCount = parseInt(process.argv[3] ?? '15', 10)
  const locationCount = parseInt(process.argv[4] ?? '8', 10)

  console.log(`Generating world: "${setting.slice(0, 60)}..."`)
  console.log(`NPCs: ${npcCount}, Locations: ${locationCount}`)

  const res = await fetch(`${BASE}/api/game/new`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settingDescription: setting, npcCount, locationCount }),
  })

  const json = await res.json()

  if (!json.success) {
    console.error('Failed:', json.error)
    process.exit(1)
  }

  const { world } = json.data
  console.log(`\nWorld: ${world.name}`)
  console.log(`Locations (${world.locations.length}):`)
  for (const loc of world.locations) {
    console.log(`  ${loc.name} (${loc.type}) - connects to ${loc.connections.length} places`)
  }
  console.log(`\nNPCs (${world.npcs.length}):`)
  for (const npc of world.npcs) {
    console.log(`  ${npc.name} (${npc.occupation}, age ${npc.age})`)
  }
  console.log(`\nMysteries (${world.mysteries.length}):`)
  for (const m of world.mysteries) {
    console.log(`  ${m.name}`)
  }
}

main().catch(console.error)
