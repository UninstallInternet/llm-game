import { useState, useRef, useEffect } from 'react'
import { useGameStore } from '../../stores/gameStore'
import { useChat } from '../../hooks/useChat'
import type { ApiResponse, PlayerActionResponse } from '../../../shared/types'

export function ChatPanel() {
  const [input, setInput] = useState('')
  const [actionLoading, setActionLoading] = useState(false)
  const [showPlayerDetail, setShowPlayerDetail] = useState(false)
  const [narrativeLog, setNarrativeLog] = useState<Array<{ type: 'action' | 'result' | 'system'; text: string }>>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const currentNpc = useGameStore((s) => s.currentNpc)
  const player = useGameStore((s) => s.player)
  const world = useGameStore((s) => s.world)
  const chatLoading = useGameStore((s) => s.chatLoading)
  const { sendMessage } = useChat()

  const conversation = currentNpc && player ? player.conversationHistory[currentNpc.id] ?? [] : []
  const location = world?.locations.find((l) => l.id === player?.currentLocationId)
  const isConversing = !!currentNpc

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [conversation.length, chatLoading, narrativeLog.length])

  async function handleAction(actionText: string) {
    if (!actionText.trim() || actionLoading) return
    setActionLoading(true)
    setNarrativeLog((prev) => [...prev, { type: 'action', text: actionText }])

    try {
      const res = await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: actionText }),
      })
      const json = (await res.json()) as ApiResponse<PlayerActionResponse>
      if (json.success && json.data) {
        const d = json.data
        const color = d.outcome === 'strong_success' ? 'success' : d.outcome === 'failure' ? 'fail' : 'partial'
        setNarrativeLog((prev) => [...prev, {
          type: 'result',
          text: `[${color}] ${d.narrative}${d.itemFound ? ` [+${d.itemFound.name}]` : ''}${d.injury ? ` [Injury: ${d.injury}]` : ''}`,
        }])
        // Refresh state
        const stateRes = await fetch('/api/game/state')
        const stateJson = await stateRes.json()
        if (stateJson.success && stateJson.data) {
          useGameStore.getState().setGameState(stateJson.data.world, stateJson.data.player)
        }
      } else {
        setNarrativeLog((prev) => [...prev, { type: 'result', text: `Error: ${json.error}` }])
      }
    } catch {
      setNarrativeLog((prev) => [...prev, { type: 'result', text: 'Action failed.' }])
    }
    setActionLoading(false)
  }

  async function handleSend() {
    if (!input.trim()) return
    const msg = input.trim()
    setInput('')

    if (isConversing) {
      await sendMessage(currentNpc.id, msg)
    } else {
      await handleAction(msg)
    }
  }

  // Quick action buttons
  const unsearchedContainers = location?.containers.filter((c) => (c.searchCount ?? 0) === 0 || (world && world.currentTick - (c.lastSearchTick ?? 0) >= 6)) ?? []
  const locationItems = location?.items ?? []

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Player Status Bar — always visible, expandable */}
      {player && (
        <div className="border-b border-gray-800 bg-gray-950 text-xs shrink-0">
          <button
            onClick={() => setShowPlayerDetail(!showPlayerDetail)}
            className="w-full px-4 py-2 text-left hover:bg-gray-900/50 transition-colors"
          >
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1">
                <span className="text-gray-500">HP</span>
                <div className="w-20 h-2 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${(player.physical?.health ?? 100) > 60 ? 'bg-green-500' : (player.physical?.health ?? 100) > 30 ? 'bg-yellow-500' : 'bg-red-500'}`}
                    style={{ width: `${player.physical?.health ?? 100}%` }}
                  />
                </div>
                <span className="text-gray-400">{player.physical?.health ?? 100}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-gray-500">EN</span>
                <div className="w-16 h-2 bg-gray-800 rounded-full overflow-hidden">
                  <div className="h-full bg-yellow-500 rounded-full" style={{ width: `${player.physical?.energy ?? 100}%` }} />
                </div>
                <span className="text-gray-400">{player.physical?.energy ?? 100}</span>
              </div>
              {(player.physical?.injuries?.length ?? 0) > 0 && (
                <span className="text-orange-400">Hurt: {player.physical!.injuries.join(', ')}</span>
              )}
              <span className="text-gray-600 ml-auto">{showPlayerDetail ? '\u25B2' : '\u25BC'} {player.inventory?.length ?? 0} items</span>
            </div>
          </button>

          {/* Expanded player detail */}
          {showPlayerDetail && (
            <div className="px-4 pb-2 space-y-2 border-t border-gray-800/50">
              <div className="flex items-center gap-1.5 flex-wrap pt-1">
                <span className="text-gray-500">Inventory:</span>
                {(player.inventory?.length ?? 0) === 0
                  ? <span className="text-gray-600 italic">empty</span>
                  : player.inventory!.map((item, i) => (
                      <span key={i} className="bg-cyan-900/30 px-1.5 py-0.5 rounded text-cyan-300 border border-cyan-800/30" title={`${item.description} [${item.tags?.join(', ')}]`}>
                        {item.name}
                      </span>
                    ))
                }
              </div>
              <div className="text-gray-500">
                Status: <span className="text-gray-300">{player.physical?.status ?? 'alive'}</span>
                {' '}&middot;{' '}
                Known NPCs: <span className="text-gray-300">{player.knownNpcIds?.length ?? 0}</span>
                {' '}&middot;{' '}
                Locations visited: <span className="text-gray-300">{player.knownLocationIds?.length ?? 0}</span>
              </div>
              {(player.actionLog?.length ?? 0) > 0 && (
                <div>
                  <span className="text-gray-500">Recent actions:</span>
                  {player.actionLog!.slice(-3).map((a, i) => (
                    <div key={i} className="text-gray-400 pl-2 text-[10px]">{a.action} &rarr; {a.result.slice(0, 60)}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* NPC Approach Notification */}
      {!isConversing && useGameStore.getState().pendingApproach && (() => {
        const approach = useGameStore.getState().pendingApproach!
        return (
          <div className="px-4 py-3 bg-amber-900/30 border-b border-amber-700/50 flex items-center justify-between shrink-0">
            <div className="text-sm">
              <span className="text-amber-400 font-medium">{approach.npcName}</span>
              <span className="text-gray-300"> approaches you: </span>
              <span className="text-gray-400 italic">&quot;{approach.reason}&quot;</span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  const npc = world?.npcs.find((n) => n.id === approach.npcId)
                  if (npc) useGameStore.getState().setCurrentNpc(npc)
                  useGameStore.setState({ pendingApproach: null })
                }}
                className="px-3 py-1 text-xs bg-amber-600 hover:bg-amber-500 rounded font-medium transition-colors"
              >
                Talk
              </button>
              <button
                onClick={() => useGameStore.setState({ pendingApproach: null })}
                className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded transition-colors"
              >
                Ignore
              </button>
            </div>
          </div>
        )
      })()}

      {/* Context header — always shows where you are + what you're doing */}
      <div className="p-3 border-b border-gray-800 bg-gray-900/50 flex items-center justify-between shrink-0">
        {isConversing ? (
          <>
            <div>
              <span className="font-medium text-amber-400">{currentNpc.name}</span>
              <span className="text-sm text-gray-500 ml-2">{currentNpc.occupation}</span>
            </div>
            <button
              onClick={() => useGameStore.getState().setCurrentNpc(null)}
              className="text-xs text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded border border-gray-700 transition-colors"
            >
              &#x2190; Back to {location?.name ?? 'exploration'}
            </button>
          </>
        ) : (
          <div>
            <span className="font-medium text-emerald-400">{location?.name ?? 'Unknown'}</span>
            <span className="text-sm text-gray-500 ml-2">Exploring</span>
          </div>
        )}
      </div>

      {/* Main content area */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        {/* ── Conversation mode ── */}
        {isConversing && (
          <>
            {conversation.length === 0 && (
              <div className="text-center text-gray-600 text-sm py-4">
                <p className="text-gray-500 mb-1">{currentNpc.appearance}</p>
              </div>
            )}
            {conversation.map((turn, i) => (
              <div key={i} className={`flex ${turn.role === 'player' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-md px-3 py-2 rounded-lg text-sm ${
                  turn.role === 'player' ? 'bg-blue-900/50 text-blue-100' : 'bg-gray-800 text-gray-200'
                }`}>
                  {turn.role === 'npc' && (
                    <span className="text-xs text-amber-400 font-medium block mb-1">{currentNpc.name}</span>
                  )}
                  <FormattedText text={turn.content} />
                </div>
              </div>
            ))}
            {chatLoading && (
              <div className="flex justify-start">
                <div className="bg-gray-800 px-3 py-2 rounded-lg text-sm text-gray-400 animate-pulse">thinking...</div>
              </div>
            )}
          </>
        )}

        {/* ── Exploration / Action mode ── */}
        {!isConversing && (
          <>
            {/* Location info */}
            <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-4 mb-2">
              <h2 className="text-emerald-400 font-medium mb-1">{location?.name}</h2>
              <p className="text-sm text-gray-400">{location?.description}</p>

              {location && location.fixtures.length > 0 && (
                <div className="mt-2 text-xs text-gray-500">
                  <span className="text-gray-400">You see: </span>
                  {location.fixtures.join(', ')}
                </div>
              )}

              {locationItems.length > 0 && (
                <div className="mt-2 flex gap-2 flex-wrap">
                  {locationItems.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => handleAction(`pick up ${item.name}`)}
                      disabled={actionLoading}
                      className="text-xs bg-cyan-900/30 text-cyan-300 px-2 py-1 rounded hover:bg-cyan-800/40 transition-colors"
                    >
                      Pick up: {item.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Quick action buttons */}
            <div className="flex gap-2 flex-wrap mb-2">
              {unsearchedContainers.length > 0 && (
                unsearchedContainers.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => handleAction(`search the ${c.name}`)}
                    disabled={actionLoading}
                    className="text-xs bg-emerald-900/30 text-emerald-300 px-3 py-1.5 rounded border border-emerald-800/30 hover:bg-emerald-800/40 transition-colors"
                  >
                    Search: {c.name}
                  </button>
                ))
              )}
              <button
                onClick={() => handleAction('look around carefully')}
                disabled={actionLoading}
                className="text-xs bg-gray-800 text-gray-300 px-3 py-1.5 rounded border border-gray-700 hover:bg-gray-700 transition-colors"
              >
                Look around
              </button>
            </div>

            {/* Narrative log */}
            {narrativeLog.map((entry, i) => {
              if (entry.type === 'action') {
                return (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-lg px-3 py-2 rounded-lg text-sm bg-emerald-900/50 text-emerald-100">
                      <span className="text-xs text-emerald-400 block mb-1">You:</span>
                      {entry.text}
                    </div>
                  </div>
                )
              }

              // Split NPC responses into individual bubbles
              // Format: "Name: *action* speech\n\nName: *action* speech"
              const npcLines = entry.text.split(/\n\n+/).filter((l) => l.trim())
              const hasMultipleNpcs = npcLines.length > 1 && npcLines.some((l) => /^[A-Z][a-z]+ ?[A-Z]?[a-z]*:/.test(l.trim()))

              if (hasMultipleNpcs) {
                return npcLines.map((line, li) => {
                  const colonIdx = line.indexOf(':')
                  const speaker = colonIdx > 0 && colonIdx < 30 ? line.slice(0, colonIdx).trim() : null
                  const speech = speaker ? line.slice(colonIdx + 1).trim() : line.trim()

                  return (
                    <div key={`${i}-${li}`} className="flex justify-start">
                      <div className="max-w-lg px-3 py-2 rounded-lg text-sm bg-gray-800 text-gray-200">
                        {speaker && (
                          <span className="text-xs text-amber-400 font-medium block mb-1">{speaker}</span>
                        )}
                        <FormattedText text={speech} />
                      </div>
                    </div>
                  )
                })
              }

              // Single result bubble
              const isSuccess = entry.text.includes('[success]')
              const isFail = entry.text.includes('[fail]')
              return (
                <div key={i} className="flex justify-start">
                  <div className={`max-w-lg px-3 py-2 rounded-lg text-sm ${
                    isSuccess ? 'bg-green-900/30 text-green-200 border border-green-800/30'
                    : isFail ? 'bg-red-900/30 text-red-200 border border-red-800/30'
                    : 'bg-gray-800 text-gray-200'
                  }`}>
                    <FormattedText text={entry.text} />
                  </div>
                </div>
              )
            })}
            {actionLoading && (
              <div className="bg-gray-800 px-3 py-2 rounded-lg text-sm text-gray-400 inline-block animate-pulse">
                resolving...
              </div>
            )}
          </>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input bar */}
      <div className="p-3 border-t border-gray-800 shrink-0">
        <form onSubmit={(e) => { e.preventDefault(); handleSend() }} className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={isConversing
              ? `Say something to ${currentNpc.name}...`
              : 'What do you do? (type anything: search, examine, hide, use item...)'
            }
            className={`flex-1 bg-gray-800 border rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none ${
              isConversing ? 'border-gray-700 focus:border-amber-500' : 'border-emerald-900 focus:border-emerald-500'
            }`}
            disabled={chatLoading || actionLoading}
            autoFocus
          />
          <button
            type="submit"
            disabled={!input.trim() || chatLoading || actionLoading}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:bg-gray-700 disabled:text-gray-500 ${
              isConversing ? 'bg-amber-600 hover:bg-amber-500' : 'bg-emerald-600 hover:bg-emerald-500'
            }`}
          >
            {isConversing ? 'Say' : 'Do'}
          </button>
        </form>
      </div>
    </div>
  )
}

// Renders *action text* as italic and regular text as normal
function FormattedText({ text }: { text: string }) {
  const parts = text.split(/(\*[^*]+\*)/)
  return (
    <span>
      {parts.map((part, i) => {
        if (part.startsWith('*') && part.endsWith('*')) {
          return <em key={i} className="text-gray-400 not-italic text-xs">{part.slice(1, -1)}</em>
        }
        return <span key={i}>{part}</span>
      })}
    </span>
  )
}
