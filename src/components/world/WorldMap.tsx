import { useMemo, useCallback } from 'react'
import { useGameStore } from '../../stores/gameStore'
import type { ApiResponse, Location, NPC } from '../../../shared/types'

interface NodePosition {
  id: string
  x: number
  y: number
}

// Force-directed layout: connected nodes attract, all nodes repel
function layoutNodes(locations: Location[]): NodePosition[] {
  const count = locations.length
  if (count === 0) return []

  const W = 380
  const H = 260
  const PAD = 40

  // Initialize positions in a grid to avoid overlap
  const cols = Math.ceil(Math.sqrt(count))
  const positions: NodePosition[] = locations.map((loc, i) => ({
    id: loc.id,
    x: PAD + ((i % cols) / Math.max(1, cols - 1)) * (W - PAD * 2) + (Math.random() - 0.5) * 20,
    y: PAD + (Math.floor(i / cols) / Math.max(1, Math.ceil(count / cols) - 1)) * (H - PAD * 2) + (Math.random() - 0.5) * 20,
  }))

  // Build adjacency for spring forces
  const adjSet = new Set<string>()
  for (const loc of locations) {
    for (const conn of loc.connections) {
      adjSet.add(`${loc.id}|${conn}`)
    }
  }

  const isConnected = (a: string, b: string) => adjSet.has(`${a}|${b}`) || adjSet.has(`${b}|${a}`)

  // Run force simulation (50 iterations)
  for (let iter = 0; iter < 60; iter++) {
    const forces = positions.map(() => ({ fx: 0, fy: 0 }))

    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const dx = positions[j].x - positions[i].x
        const dy = positions[j].y - positions[i].y
        const dist = Math.max(10, Math.sqrt(dx * dx + dy * dy))
        const nx = dx / dist
        const ny = dy / dist

        // Repulsion (all pairs)
        const repulsion = 3000 / (dist * dist)
        forces[i].fx -= nx * repulsion
        forces[i].fy -= ny * repulsion
        forces[j].fx += nx * repulsion
        forces[j].fy += ny * repulsion

        // Attraction (connected pairs only)
        if (isConnected(positions[i].id, positions[j].id)) {
          const idealDist = 80
          const attraction = (dist - idealDist) * 0.05
          forces[i].fx += nx * attraction
          forces[i].fy += ny * attraction
          forces[j].fx -= nx * attraction
          forces[j].fy -= ny * attraction
        }
      }
    }

    // Apply forces with damping
    const damping = 0.3
    for (let i = 0; i < count; i++) {
      positions[i].x += forces[i].fx * damping
      positions[i].y += forces[i].fy * damping
      // Clamp to bounds
      positions[i].x = Math.max(PAD, Math.min(W - PAD, positions[i].x))
      positions[i].y = Math.max(PAD, Math.min(H - PAD, positions[i].y))
    }
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
    // Stable key: only relayout when location count/ids change
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
      <svg viewBox="0 0 380 260" className="w-full" style={{ maxHeight: '200px' }}>
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
                <text x={pos.x} y={pos.y + 4} textAnchor="middle" fontSize={10}>
                  &#x1F512;
                </text>
              )}

              {isPlayer && (
                <text x={pos.x} y={pos.y + 4} textAnchor="middle" fontSize={11}>
                  &#x1F464;
                </text>
              )}

              <text
                x={pos.x}
                y={pos.y + 24}
                textAnchor="middle"
                fill={isPlayer ? '#fbbf24' : isConnected ? '#9ca3af' : '#4b5563'}
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
