import { useMemo, useCallback } from 'react'
import { useGameStore } from '../../stores/gameStore'
import type { ApiResponse, Location, NPC } from '../../../shared/types'

interface NodePosition {
  id: string
  x: number
  y: number
}

// Deterministic seeded random for consistent layout
function seededRandom(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 16807 + 0) % 2147483647
    return (s - 1) / 2147483646
  }
}

function layoutNodes(locations: Location[]): NodePosition[] {
  const count = locations.length
  if (count === 0) return []
  if (count === 1) return [{ id: locations[0].id, x: 190, y: 140 }]

  const W = 380
  const H = 280
  const PAD = 50

  // Seed from location IDs for deterministic layout
  const seed = locations.reduce((s, l) => s + l.id.charCodeAt(l.id.length - 1) * 31, 7)
  const rand = seededRandom(seed)

  // BFS-based initial placement: start from first location, fan out by connections
  const placed = new Map<string, { x: number; y: number }>()
  const queue: string[] = [locations[0].id]
  const visited = new Set<string>()
  const cx = W / 2
  const cy = H / 2

  placed.set(locations[0].id, { x: cx, y: cy })
  visited.add(locations[0].id)

  const angleStep = (2 * Math.PI) / Math.max(4, count)
  let ring = 1

  while (queue.length > 0) {
    const batch = [...queue]
    queue.length = 0

    for (const locId of batch) {
      const loc = locations.find((l) => l.id === locId)
      if (!loc) continue
      const parent = placed.get(locId)!

      let childIdx = 0
      for (const connId of loc.connections) {
        if (visited.has(connId)) continue
        visited.add(connId)
        queue.push(connId)

        const baseAngle = angleStep * (placed.size - 1) + childIdx * 0.8
        const dist = 60 + ring * 30
        const x = parent.x + Math.cos(baseAngle) * dist + (rand() - 0.5) * 15
        const y = parent.y + Math.sin(baseAngle) * dist + (rand() - 0.5) * 15
        placed.set(connId, { x, y })
        childIdx++
      }
    }
    ring++
  }

  // Place any unvisited (shouldn't happen but safety)
  for (const loc of locations) {
    if (!placed.has(loc.id)) {
      placed.set(loc.id, { x: PAD + rand() * (W - PAD * 2), y: PAD + rand() * (H - PAD * 2) })
    }
  }

  // Convert to array
  let positions: NodePosition[] = locations.map((loc) => {
    const p = placed.get(loc.id)!
    return { id: loc.id, x: p.x, y: p.y }
  })

  // Build adjacency
  const adjSet = new Set<string>()
  for (const loc of locations) {
    for (const conn of loc.connections) {
      adjSet.add(`${loc.id}|${conn}`)
    }
  }
  const isConnected = (a: string, b: string) => adjSet.has(`${a}|${b}`) || adjSet.has(`${b}|${a}`)

  // Force-directed refinement (40 iterations)
  for (let iter = 0; iter < 40; iter++) {
    const forces = positions.map(() => ({ fx: 0, fy: 0 }))

    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const dx = positions[j].x - positions[i].x
        const dy = positions[j].y - positions[i].y
        const dist = Math.max(15, Math.sqrt(dx * dx + dy * dy))
        const nx = dx / dist
        const ny = dy / dist

        // Repulsion
        const repulsion = 2500 / (dist * dist)
        forces[i].fx -= nx * repulsion
        forces[i].fy -= ny * repulsion
        forces[j].fx += nx * repulsion
        forces[j].fy += ny * repulsion

        // Attraction for connected
        if (isConnected(positions[i].id, positions[j].id)) {
          const ideal = 90
          const attraction = (dist - ideal) * 0.04
          forces[i].fx += nx * attraction
          forces[i].fy += ny * attraction
          forces[j].fx -= nx * attraction
          forces[j].fy -= ny * attraction
        }
      }

      // Center gravity (gentle pull toward center)
      forces[i].fx += (cx - positions[i].x) * 0.005
      forces[i].fy += (cy - positions[i].y) * 0.005
    }

    positions = positions.map((p, i) => ({
      id: p.id,
      x: Math.max(PAD, Math.min(W - PAD, p.x + forces[i].fx * 0.3)),
      y: Math.max(PAD, Math.min(H - PAD, p.y + forces[i].fy * 0.3)),
    }))
  }

  return positions
}

export function WorldMap() {
  const world = useGameStore((s) => s.world)
  const player = useGameStore((s) => s.player)
  const movePlayerTo = useGameStore((s) => s.movePlayerTo)
  const setCurrentNpc = useGameStore((s) => s.setCurrentNpc)
  const addEventLog = useGameStore((s) => s.addEventLog)

  const positions = useMemo(
    () => (world ? layoutNodes(world.locations) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [world?.locations.map((l) => l.id).join(',')]
  )

  const handleMove = useCallback(
    async (locationId: string) => {
      if (!player || !world) return
      const currentLoc = world.locations.find((l) => l.id === player.currentLocationId)
      if (!currentLoc?.connections.includes(locationId)) return

      try {
        const res = await fetch('/api/world/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locationId }),
        })
        const json = (await res.json()) as ApiResponse<{ location: Location; npcs: NPC[] }>
        if (json.success && json.data) {
          movePlayerTo(json.data.location.id, json.data.npcs)
          setCurrentNpc(null)
          addEventLog(`You arrive at ${json.data.location.name}.`)
        }
      } catch { /* ignore */ }
    },
    [world, player, movePlayerTo, setCurrentNpc, addEventLog]
  )

  if (!world || !player) return null

  const currentLoc = world.locations.find((l) => l.id === player.currentLocationId)
  const connectedIds = new Set(currentLoc?.connections ?? [])
  const posMap = new Map(positions.map((p) => [p.id, p]))

  // Build unique edges
  const edges: Array<{ from: NodePosition; to: NodePosition; key: string }> = []
  const edgeSet = new Set<string>()
  for (const loc of world.locations) {
    const from = posMap.get(loc.id)
    if (!from) continue
    for (const connId of loc.connections) {
      const key = [loc.id, connId].sort().join('-')
      if (edgeSet.has(key)) continue
      edgeSet.add(key)
      const to = posMap.get(connId)
      if (to) edges.push({ from, to, key })
    }
  }

  return (
    <div className="p-2 border-b border-gray-800">
      <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1 px-2">
        Map
      </h3>
      <svg viewBox="0 0 380 280" className="w-full" style={{ maxHeight: '220px' }}>
        {/* Edges */}
        {edges.map((e) => {
          const isPlayerPath =
            (e.from.id === player.currentLocationId && connectedIds.has(e.to.id)) ||
            (e.to.id === player.currentLocationId && connectedIds.has(e.from.id))
          return (
            <line
              key={e.key}
              x1={e.from.x}
              y1={e.from.y}
              x2={e.to.x}
              y2={e.to.y}
              stroke={isPlayerPath ? '#d97706' : '#374151'}
              strokeWidth={isPlayerPath ? 2 : 1}
              opacity={isPlayerPath ? 0.8 : 0.3}
            />
          )
        })}

        {/* Nodes */}
        {positions.map((pos) => {
          const loc = world.locations.find((l) => l.id === pos.id)
          if (!loc) return null

          const isPlayer = pos.id === player.currentLocationId
          const isConnected = connectedIds.has(pos.id)
          const npcsHere = world.npcs.filter((n) => n.currentLocationId === pos.id).length
          const locked = (loc.securityLevel ?? 0) >= 3

          return (
            <g
              key={pos.id}
              onClick={() => isConnected && !isPlayer ? handleMove(pos.id) : undefined}
              className={isConnected && !isPlayer ? 'cursor-pointer' : ''}
            >
              {isPlayer && (
                <circle cx={pos.x} cy={pos.y} r={22} fill="#d97706" opacity={0.12} />
              )}
              <circle
                cx={pos.x}
                cy={pos.y}
                r={14}
                fill={isPlayer ? '#92400e' : isConnected ? '#1f2937' : '#111827'}
                stroke={isPlayer ? '#d97706' : isConnected ? '#4b5563' : '#1f2937'}
                strokeWidth={isPlayer ? 2.5 : 1.5}
              />

              {npcsHere > 0 && (
                <>
                  <circle cx={pos.x + 11} cy={pos.y - 11} r={6} fill="#1e40af" />
                  <text x={pos.x + 11} y={pos.y - 7.5} textAnchor="middle" fill="white" fontSize={8} fontWeight="bold">
                    {npcsHere}
                  </text>
                </>
              )}

              {locked && !isPlayer && (
                <text x={pos.x} y={pos.y + 4} textAnchor="middle" fontSize={10}>&#x1F512;</text>
              )}

              {isPlayer && (
                <text x={pos.x} y={pos.y + 4} textAnchor="middle" fontSize={11}>&#x1F464;</text>
              )}

              <text
                x={pos.x}
                y={pos.y + 24}
                textAnchor="middle"
                fill={isPlayer ? '#fbbf24' : isConnected ? '#9ca3af' : '#6b7280'}
                fontSize={8}
                fontWeight={isPlayer ? 'bold' : 'normal'}
              >
                {loc.name.length > 22 ? loc.name.slice(0, 20) + '..' : loc.name}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
