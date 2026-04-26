import { useGameStore } from '../../stores/gameStore'

export function NPCList() {
  const world = useGameStore((s) => s.world)
  const player = useGameStore((s) => s.player)
  const currentNpc = useGameStore((s) => s.currentNpc)
  const setCurrentNpc = useGameStore((s) => s.setCurrentNpc)

  if (!world || !player) return null

  const npcsHere = world.npcs.filter((n) => n.currentLocationId === player.currentLocationId)

  return (
    <div className="flex-1 overflow-y-auto border-b border-gray-800">
      <div className="p-3 border-b border-gray-800">
        <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider">
          People Here ({npcsHere.length})
        </h3>
      </div>
      <div className="p-2 space-y-1">
        {npcsHere.length === 0 && (
          <p className="text-sm text-gray-600 px-2 py-4 text-center">Nobody here right now.</p>
        )}
        {npcsHere.map((npc) => {
          const isSelected = currentNpc?.id === npc.id
          const isKnown = player.knownNpcIds.includes(npc.id)

          return (
            <button
              key={npc.id}
              onClick={() => setCurrentNpc(npc)}
              className={`w-full text-left p-2 rounded transition-colors ${
                isSelected
                  ? 'bg-amber-900/30 border border-amber-700/50'
                  : 'hover:bg-gray-800 border border-transparent'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className={`text-sm ${isSelected ? 'text-amber-400' : 'text-gray-200'}`}>
                  {isKnown ? npc.name : 'Unknown Person'}
                </span>
                <span className="text-xs text-gray-600">{moodEmoji(npc.mood.current)}</span>
              </div>
              <div className="text-xs text-gray-500">
                {npc.occupation}
                {isKnown && npc.mood.toward_player !== 0 && (
                  <span className={npc.mood.toward_player > 0 ? ' text-green-600' : ' text-red-600'}>
                    {' \u00B7 '}{npc.mood.toward_player > 0 ? '+' : ''}{npc.mood.toward_player}
                  </span>
                )}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function moodEmoji(mood: string): string {
  const moods: Record<string, string> = {
    happy: '\uD83D\uDE0A',
    angry: '\uD83D\uDE20',
    sad: '\uD83D\uDE1E',
    fearful: '\uD83D\uDE28',
    suspicious: '\uD83E\uDD28',
    neutral: '\uD83D\uDE10',
    excited: '\uD83D\uDE04',
    worried: '\uD83D\uDE1F',
  }
  return moods[mood.toLowerCase()] ?? '\uD83D\uDE10'
}
