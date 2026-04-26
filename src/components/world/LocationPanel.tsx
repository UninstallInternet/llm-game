import { useGameStore } from '../../stores/gameStore'

export function LocationPanel() {
  const world = useGameStore((s) => s.world)
  const player = useGameStore((s) => s.player)

  if (!world || !player) return null

  const location = world.locations.find((l) => l.id === player.currentLocationId)
  if (!location) return null

  const npcsHere = world.npcs.filter((n) => n.currentLocationId === location.id)

  return (
    <div className="p-4 border-b border-gray-800">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-lg">{locationIcon(location.type)}</span>
        <h2 className="font-bold text-amber-400">{location.name}</h2>
      </div>
      <p className="text-sm text-gray-400 mb-3">{location.description}</p>
      {npcsHere.length > 0 && (
        <div className="text-xs text-gray-500">
          {npcsHere.length} {npcsHere.length === 1 ? 'person' : 'people'} here
        </div>
      )}
    </div>
  )
}

function locationIcon(type: string): string {
  const icons: Record<string, string> = {
    tavern: '\uD83C\uDF7A',
    market: '\uD83C\uDFEA',
    home: '\uD83C\uDFE0',
    temple: '\u26EA',
    workshop: '\uD83D\uDD28',
    government: '\uD83C\uDFDB\uFE0F',
    nature: '\uD83C\uDF33',
    other: '\uD83D\uDCCD',
  }
  return icons[type] ?? '\uD83D\uDCCD'
}
