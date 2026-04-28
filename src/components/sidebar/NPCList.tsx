import { useState } from 'react'
import { useGameStore } from '../../stores/gameStore'
import type { NPC } from '../../../shared/types'

export function NPCList() {
  const world = useGameStore((s) => s.world)
  const player = useGameStore((s) => s.player)
  const currentNpc = useGameStore((s) => s.currentNpc)
  const setCurrentNpc = useGameStore((s) => s.setCurrentNpc)
  const [inspecting, setInspecting] = useState<string | null>(null)

  if (!world || !player) return null

  const npcsHere = world.npcs.filter((n) => n.currentLocationId === player.currentLocationId)

  return (
    <div className="flex-1 overflow-y-auto border-b border-gray-800 min-h-0">
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
          const isInspecting = inspecting === npc.id
          const typedNpc = npc as NPC

          return (
            <div key={npc.id}>
              <div className="flex gap-1">
                {/* Main NPC button — click to talk */}
                <button
                  onClick={() => setCurrentNpc(npc)}
                  className={`flex-1 text-left p-2 rounded-l transition-colors ${
                    isSelected
                      ? 'bg-amber-900/30 border border-amber-700/50'
                      : 'hover:bg-gray-800 border border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {(npc as { portraitUrl?: string | null }).portraitUrl && (
                        <img
                          src={(npc as { portraitUrl?: string | null }).portraitUrl!}
                          alt={npc.name}
                          className="w-8 h-8 rounded object-cover flex-shrink-0"
                        />
                      )}
                      <span className={`text-sm ${isSelected ? 'text-amber-400' : 'text-gray-200'}`}>
                        {isKnown ? npc.name : 'Unknown Person'}
                      </span>
                    </div>
                    <span className="text-xs">{dispositionIndicator(disposition)}</span>
                  </div>
                  <div className="text-xs text-gray-500 flex items-center gap-1 flex-wrap">
                    <span>{npc.occupation}</span>
                    <span className="text-gray-700">&middot;</span>
                    <span className="italic">{npc.mood.current}</span>
                    {typedNpc.physical?.status !== 'alive' && (
                      <span className="text-red-500">[{typedNpc.physical.status}]</span>
                    )}
                  </div>
                  {/* State flags */}
                  {(typedNpc.stateFlags?.length ?? 0) > 0 && (
                    <div className="flex gap-1 flex-wrap mt-1">
                      {typedNpc.stateFlags.map((flag, fi) => (
                        <span key={fi} className="text-purple-400 bg-purple-900/20 px-1 rounded text-[10px]">{flag}</span>
                      ))}
                    </div>
                  )}
                  {/* Disposition bar */}
                  {isKnown && disposition !== 0 && (
                    <div className="mt-1 flex items-center gap-1">
                      <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${disposition > 0 ? 'bg-green-500' : 'bg-red-500'}`}
                          style={{ width: `${Math.min(100, Math.abs(disposition))}%` }}
                        />
                      </div>
                      <span className={`text-xs ${disposition > 0 ? 'text-green-500' : 'text-red-500'}`}>
                        {disposition > 0 ? '+' : ''}{disposition}
                      </span>
                    </div>
                  )}
                </button>

                {/* Inspect button */}
                <button
                  onClick={() => setInspecting(isInspecting ? null : npc.id)}
                  className={`px-1.5 rounded-r text-[10px] transition-colors ${
                    isInspecting
                      ? 'bg-cyan-900/40 text-cyan-300 border border-cyan-700/50'
                      : 'bg-gray-800 text-gray-600 hover:text-gray-400 border border-transparent'
                  }`}
                  title="Inspect NPC details"
                >
                  i
                </button>
              </div>

              {/* Expanded detail panel */}
              {isInspecting && (
                <NpcDetailPanel npc={typedNpc} world={world} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function NpcDetailPanel({ npc, world }: { npc: NPC; world: { npcs: NPC[] } }) {
  const portraitUrl = (npc as { portraitUrl?: string | null }).portraitUrl
  return (
    <div className="mx-1 mb-2 p-2 bg-gray-900 border border-gray-700 rounded text-[11px] space-y-2 max-h-[500px] overflow-y-auto">
      {/* Full-body portrait */}
      {portraitUrl && (
        <div className="flex justify-center">
          <img
            src={portraitUrl}
            alt={npc.name}
            className="w-40 h-40 object-contain rounded border border-gray-700 bg-gray-950"
          />
        </div>
      )}
      {/* Physical */}
      <Section title="Physical">
        <div className="flex gap-3">
          <span className="text-red-400">HP: {npc.physical?.health ?? 100}</span>
          <span className="text-yellow-400">EN: {npc.physical?.energy ?? 100}</span>
          <span className="text-gray-400">Status: {npc.physical?.status ?? 'alive'}</span>
        </div>
        {(npc.physical?.injuries?.length ?? 0) > 0 && (
          <div className="text-orange-400">Injuries: {npc.physical.injuries.join(', ')}</div>
        )}
      </Section>

      {/* Inventory */}
      <Section title={`Inventory (${npc.inventory?.length ?? 0})`}>
        {(npc.inventory?.length ?? 0) === 0
          ? <span className="text-gray-600">empty</span>
          : npc.inventory.map((item, i) => (
              <div key={i} className="flex items-center gap-1">
                <span className="text-cyan-300">{item.name}</span>
                <span className="text-gray-600">[{item.tags?.join(', ')}]</span>
              </div>
            ))
        }
      </Section>

      {/* State Flags */}
      <Section title={`State Tags (${npc.stateFlags?.length ?? 0})`}>
        {(npc.stateFlags?.length ?? 0) === 0
          ? <span className="text-gray-600">none</span>
          : <div className="flex gap-1 flex-wrap">
              {npc.stateFlags.map((f, i) => (
                <span key={i} className="bg-purple-900/30 text-purple-300 px-1.5 py-0.5 rounded">{f}</span>
              ))}
            </div>
        }
      </Section>

      {/* Agreements */}
      <Section title={`Agreements (${npc.agreements?.filter((a) => a.active).length ?? 0})`}>
        {(npc.agreements?.length ?? 0) === 0
          ? <span className="text-gray-600">none</span>
          : npc.agreements.filter((a) => a.active).map((a, i) => {
              const other = a.withId === 'player' ? 'Player' : world.npcs.find((n) => n.id === a.withId)?.name ?? a.withId
              return (
                <div key={i} className="text-green-300">
                  With {other}: {a.content}
                </div>
              )
            })
        }
      </Section>

      {/* Active Plan */}
      <Section title="Active Plan">
        {npc.activePlan?.status === 'active' ? (
          <div>
            <div className="text-amber-300 font-medium">{npc.activePlan.goal}</div>
            {npc.activePlan.steps.map((s, i) => {
              const iconMap: Record<string, string> = { completed: '\u2713', active: '\u25B6', pending: '\u00B7', failed: '\u2717', skipped: '-' }
              const colorMap: Record<string, string> = { completed: 'text-green-400', active: 'text-amber-400', pending: 'text-gray-600', failed: 'text-red-400', skipped: 'text-gray-700' }
              const icon = iconMap[s.status] ?? '?'
              const color = colorMap[s.status] ?? 'text-gray-500'
              return (
                <div key={i} className={`${color} pl-2`}>
                  {icon} {s.action}: {s.description.slice(0, 50)}
                </div>
              )
            })}
          </div>
        ) : <span className="text-gray-600">none</span>}
      </Section>

      {/* Relationships */}
      <Section title={`Relationships (${npc.relationships?.length ?? 0})`}>
        {(npc.relationships?.length ?? 0) === 0
          ? <span className="text-gray-600">none</span>
          : npc.relationships.slice(0, 5).map((r, i) => {
              const target = world.npcs.find((n) => n.id === r.targetNpcId)
              return (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-gray-300">{target?.name ?? '?'}</span>
                  <span className="text-gray-600">({r.type})</span>
                  <span className="text-blue-400">T:{r.trust}</span>
                  <span className="text-pink-400">A:{r.affection}</span>
                  <span className="text-yellow-400">R:{r.respect}</span>
                  {r.fear > 0 && <span className="text-red-400">F:{r.fear}</span>}
                </div>
              )
            })
        }
      </Section>

      {/* Recent Knowledge */}
      <Section title={`Memories (${npc.knowledge?.length ?? 0} total, showing last 5)`}>
        {(npc.knowledge?.length ?? 0) === 0
          ? <span className="text-gray-600">none</span>
          : npc.knowledge.slice(-5).map((k, i) => (
              <div key={i} className="text-gray-400 border-l border-gray-700 pl-1.5 mb-1">
                <span className="text-gray-300">{k.content.slice(0, 100)}</span>
                <div className="text-gray-600 text-[10px]">
                  via {k.source} | imp: {k.importance?.toFixed(1)} | tick {k.turnLearned}
                </div>
              </div>
            ))
        }
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-gray-500 font-medium uppercase text-[10px] tracking-wider mb-0.5">{title}</div>
      <div>{children}</div>
    </div>
  )
}

function dispositionIndicator(value: number): string {
  if (value >= 60) return '\u2764\uFE0F'
  if (value >= 20) return '\uD83D\uDE0A'
  if (value > -20) return '\uD83D\uDE10'
  if (value > -60) return '\uD83D\uDE12'
  return '\uD83D\uDE21'
}
