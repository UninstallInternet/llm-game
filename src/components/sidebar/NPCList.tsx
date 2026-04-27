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
          const disposition = npc.mood.toward_player

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
                <span className="text-xs">{dispositionIndicator(disposition)}</span>
              </div>
              <div className="text-xs text-gray-500 flex items-center gap-1 flex-wrap">
                <span>{npc.occupation}</span>
                <span className="text-gray-700">&middot;</span>
                <span className="italic">{npc.mood.current}</span>
                {npc.physical?.status !== 'alive' && (
                  <span className="text-red-500 ml-1">[{npc.physical.status}]</span>
                )}
                {(npc as { stateFlags?: string[] }).stateFlags?.map((flag, fi) => (
                  <span key={fi} className="text-purple-400 bg-purple-900/20 px-1 rounded text-[10px]">{flag}</span>
                ))}
              </div>
              {isKnown && disposition !== 0 && (
                <div className="mt-1 flex items-center gap-1">
                  <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${disposition > 0 ? 'bg-green-500' : 'bg-red-500'}`}
                      style={{
                        width: `${Math.abs(disposition) / 2}%`,
                        marginLeft: disposition < 0 ? `${50 + disposition / 2}%` : '50%',
                      }}
                    />
                  </div>
                  <span className={`text-xs ${disposition > 0 ? 'text-green-500' : 'text-red-500'}`}>
                    {disposition > 0 ? '+' : ''}{disposition}
                  </span>
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function dispositionIndicator(value: number): string {
  if (value >= 60) return '\u2764\uFE0F'   // heart - trusting
  if (value >= 20) return '\uD83D\uDE0A'   // smile - friendly
  if (value > -20) return '\uD83D\uDE10'    // neutral
  if (value > -60) return '\uD83D\uDE12'    // unamused - unfriendly
  return '\uD83D\uDE21'                     // angry - hostile
}
