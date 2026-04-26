import { useCallback } from 'react'
import { useGameStore } from '../../stores/gameStore'
import type { ApiResponse, Location, NPC } from '../../../shared/types'

export function LocationNav() {
  const world = useGameStore((s) => s.world)
  const player = useGameStore((s) => s.player)
  const movePlayerTo = useGameStore((s) => s.movePlayerTo)
  const setCurrentNpc = useGameStore((s) => s.setCurrentNpc)
  const addEventLog = useGameStore((s) => s.addEventLog)

  const handleMove = useCallback(
    async (locationId: string) => {
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
      } catch (err) {
        console.error('Move error:', err)
      }
    },
    [movePlayerTo, setCurrentNpc, addEventLog]
  )

  if (!world || !player) return null

  const currentLoc = world.locations.find((l) => l.id === player.currentLocationId)
  if (!currentLoc) return null

  const connectedLocations = world.locations.filter((l) => currentLoc.connections.includes(l.id))

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
        Travel to
      </h3>
      <div className="space-y-1">
        {connectedLocations.map((loc) => {
          const npcsCount = world.npcs.filter((n) => n.currentLocationId === loc.id).length
          return (
            <button
              key={loc.id}
              onClick={() => handleMove(loc.id)}
              className="w-full text-left p-2 rounded hover:bg-gray-800 transition-colors group"
            >
              <div className="text-sm text-gray-200 group-hover:text-amber-400">{loc.name}</div>
              <div className="text-xs text-gray-500">
                {loc.type}
                {npcsCount > 0 && ` \u00B7 ${npcsCount} people`}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
