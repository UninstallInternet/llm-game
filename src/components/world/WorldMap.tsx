import { useMemo, useCallback } from 'react'
import { useGameStore } from '../../stores/gameStore'
import type { ApiResponse, Location, NPC } from '../../../shared/types'

interface NodePosition {
  id: string
  x: number
  y: number
}

function layoutNodes(locations: Location[]): NodePosition[] {
  // Simple circular layout with center node
  const count = locations.length
  if (count === 0) return []

  const cx = 200
  const cy = 150
  const radius = Math.min(120, 40 + count * 12)

  return locations.map((loc, i) => {
    if (i === 0) return { id: loc.id, x: cx, y: cy }
    const angle = ((i - 1) / (count - 1)) * Math.PI * 2 - Math.PI / 2
    return {
      id: loc.id,
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    }
  })
}

export function WorldMap() {
  const world = useGameStore((s) => s.world)
  const player = useGameStore((s) => s.player)
  const movePlayerTo = useGameStore((s) => s.movePlayerTo)
  const setCurrentNpc = useGameStore((s) => s.setCurrentNpc)
  const addEventLog = useGameStore((s) => s.addEventLog)

  const positions = useMemo(
    () => (world ? layoutNodes(world.locations) : []),
    [world?.locations]
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

  // Draw edges
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
    <div className="p-2">
      <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2 px-2">
        Station Map
      </h3>
      <svg viewBox="0 0 400 300" className="w-full" style={{ maxHeight: '220px' }}>
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
              opacity={isPlayerPath ? 0.8 : 0.4}
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
              {/* Glow for player location */}
              {isPlayer && (
                <circle cx={pos.x} cy={pos.y} r={22} fill="#d97706" opacity={0.15} />
              )}

              {/* Node circle */}
              <circle
                cx={pos.x}
                cy={pos.y}
                r={16}
                fill={isPlayer ? '#92400e' : isConnected ? '#1f2937' : '#111827'}
                stroke={isPlayer ? '#d97706' : isConnected ? '#4b5563' : '#1f2937'}
                strokeWidth={isPlayer ? 2.5 : 1.5}
              />

              {/* NPC count badge */}
              {npcsHere > 0 && (
                <>
                  <circle cx={pos.x + 12} cy={pos.y - 12} r={7} fill="#1e40af" />
                  <text
                    x={pos.x + 12}
                    y={pos.y - 8}
                    textAnchor="middle"
                    fill="white"
                    fontSize={9}
                    fontWeight="bold"
                  >
                    {npcsHere}
                  </text>
                </>
              )}

              {/* Lock icon for secure areas */}
              {locked && (
                <text x={pos.x} y={pos.y + 4} textAnchor="middle" fontSize={12}>
                  &#x1F512;
                </text>
              )}

              {/* Location name */}
              <text
                x={pos.x}
                y={pos.y + 28}
                textAnchor="middle"
                fill={isPlayer ? '#fbbf24' : isConnected ? '#9ca3af' : '#4b5563'}
                fontSize={9}
                fontWeight={isPlayer ? 'bold' : 'normal'}
              >
                {loc.name.length > 20 ? loc.name.slice(0, 18) + '..' : loc.name}
              </text>
            </g>
          )
        })}

        {/* Player indicator */}
        {(() => {
          const playerPos = posMap.get(player.currentLocationId)
          if (!playerPos) return null
          return (
            <text x={playerPos.x} y={playerPos.y + 5} textAnchor="middle" fontSize={14}>
              &#x1F464;
            </text>
          )
        })()}
      </svg>
    </div>
  )
}
