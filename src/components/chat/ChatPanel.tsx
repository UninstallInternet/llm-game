import { useState, useRef, useEffect } from 'react'
import { useGameStore } from '../../stores/gameStore'
import { useChat } from '../../hooks/useChat'
import type { ApiResponse, PlayerActionResponse } from '../../../shared/types'

export function ChatPanel() {
  const [input, setInput] = useState('')
  const [actionMode, setActionMode] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [narrativeLog, setNarrativeLog] = useState<Array<{ type: 'action' | 'result'; text: string }>>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const currentNpc = useGameStore((s) => s.currentNpc)
  const player = useGameStore((s) => s.player)
  const world = useGameStore((s) => s.world)
  const chatLoading = useGameStore((s) => s.chatLoading)
  const { sendMessage } = useChat()

  const conversation = currentNpc && player ? player.conversationHistory[currentNpc.id] ?? [] : []

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [conversation.length, chatLoading, narrativeLog.length])

  async function handleSend() {
    if (!input.trim() || chatLoading || actionLoading) return
    const msg = input.trim()
    setInput('')

    if (actionMode || !currentNpc) {
      // Player action mode
      setActionLoading(true)
      setNarrativeLog((prev) => [...prev, { type: 'action', text: msg }])

      try {
        const res = await fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: msg }),
        })
        const json = (await res.json()) as ApiResponse<PlayerActionResponse>
        if (json.success && json.data) {
          const d = json.data
          setNarrativeLog((prev) => [...prev, {
            type: 'result',
            text: `[${d.outcome}] ${d.narrative}${d.itemFound ? ` (Found: ${d.itemFound.name})` : ''}${d.injury ? ` (Injured: ${d.injury})` : ''}`,
          }])
          // Refresh game state to get updated inventory/health
          const stateRes = await fetch('/api/game/state')
          const stateJson = await stateRes.json()
          if (stateJson.success && stateJson.data) {
            useGameStore.getState().setGameState(stateJson.data.world, stateJson.data.player)
          }
        } else {
          setNarrativeLog((prev) => [...prev, { type: 'result', text: `Error: ${json.error}` }])
        }
      } catch (err) {
        setNarrativeLog((prev) => [...prev, { type: 'result', text: 'Action failed.' }])
      }
      setActionLoading(false)
      return
    }

    // Chat mode
    await sendMessage(currentNpc.id, msg)
  }

  const location = world?.locations.find((l) => l.id === player?.currentLocationId)

  return (
    <div className="flex-1 flex flex-col">
      {/* Header bar: NPC or exploration mode */}
      <div className="p-3 border-b border-gray-800 bg-gray-900/50 flex items-center justify-between">
        {currentNpc ? (
          <>
            <div>
              <span className="font-medium text-amber-400">{currentNpc.name}</span>
              <span className="text-sm text-gray-500 ml-2">
                {currentNpc.occupation}, age {currentNpc.age}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">
                Mood: {currentNpc.mood.current}
              </span>
              <button
                onClick={() => useGameStore.getState().setCurrentNpc(null)}
                className="text-gray-500 hover:text-gray-300 px-2"
              >
                &#x2715;
              </button>
            </div>
          </>
        ) : (
          <div>
            <span className="font-medium text-emerald-400">{location?.name ?? 'Unknown'}</span>
            <span className="text-sm text-gray-500 ml-2">Exploring</span>
          </div>
        )}

        {/* Mode toggle */}
        <div className="flex gap-1">
          <button
            onClick={() => setActionMode(false)}
            className={`px-2 py-1 text-xs rounded ${!actionMode ? 'bg-blue-900/40 text-blue-300' : 'text-gray-500 hover:text-gray-300'}`}
          >
            Talk
          </button>
          <button
            onClick={() => setActionMode(true)}
            className={`px-2 py-1 text-xs rounded ${actionMode ? 'bg-emerald-900/40 text-emerald-300' : 'text-gray-500 hover:text-gray-300'}`}
          >
            Act
          </button>
        </div>
      </div>

      {/* Player status bar */}
      {player && (
        <div className="px-4 py-2 border-b border-gray-800 bg-gray-900/30 flex items-center gap-4 text-xs">
          <span className="text-red-400">HP: {player.physical.health}/100</span>
          <span className="text-yellow-400">Energy: {player.physical.energy}/100</span>
          {player.physical.injuries.length > 0 && (
            <span className="text-orange-400">Injuries: {player.physical.injuries.join(', ')}</span>
          )}
          {player.inventory.length > 0 && (
            <span className="text-cyan-400">
              Items: {player.inventory.map((i) => i.name).join(', ')}
            </span>
          )}
        </div>
      )}

      {/* Messages / Narrative */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {/* Chat mode with NPC */}
        {currentNpc && !actionMode && (
          <>
            {conversation.length === 0 && (
              <div className="text-center text-gray-600 text-sm py-8">
                <p className="text-gray-500 mb-1">{currentNpc.appearance}</p>
                <p>Start a conversation with {currentNpc.name}.</p>
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
                  {turn.content}
                </div>
              </div>
            ))}
            {chatLoading && (
              <div className="flex justify-start">
                <div className="bg-gray-800 px-3 py-2 rounded-lg text-sm text-gray-400">
                  <span className="animate-pulse">thinking...</span>
                </div>
              </div>
            )}
          </>
        )}

        {/* Action / exploration mode */}
        {(actionMode || !currentNpc) && (
          <>
            {narrativeLog.length === 0 && (
              <div className="text-center text-gray-600 text-sm py-8">
                <p className="text-2xl mb-3">&#x1F50D;</p>
                <p>You're at <span className="text-emerald-400">{location?.name}</span>.</p>
                <p className="text-gray-700 mt-1">{location?.description}</p>
                {location && location.containers.filter((c) => !c.searched).length > 0 && (
                  <p className="text-gray-500 mt-3">
                    You see: {location.containers.filter((c) => !c.searched).map((c) => c.name).join(', ')}
                  </p>
                )}
                {location && location.fixtures.length > 0 && (
                  <p className="text-gray-600 mt-1">
                    Fixtures: {location.fixtures.join(', ')}
                  </p>
                )}
                <p className="text-gray-600 mt-4 text-xs">
                  Try: "search the room", "examine the control panel", "hide behind the crates", or anything you can think of.
                </p>
              </div>
            )}
            {narrativeLog.map((entry, i) => (
              <div key={i} className={`flex ${entry.type === 'action' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-lg px-3 py-2 rounded-lg text-sm ${
                  entry.type === 'action'
                    ? 'bg-emerald-900/50 text-emerald-100'
                    : entry.text.includes('[strong_success]')
                      ? 'bg-green-900/30 text-green-200 border border-green-800/30'
                      : entry.text.includes('[failure]')
                        ? 'bg-red-900/30 text-red-200 border border-red-800/30'
                        : 'bg-gray-800 text-gray-200'
                }`}>
                  {entry.type === 'action' && <span className="text-xs text-emerald-400 block mb-1">You attempt:</span>}
                  {entry.text}
                </div>
              </div>
            ))}
            {actionLoading && (
              <div className="flex justify-start">
                <div className="bg-gray-800 px-3 py-2 rounded-lg text-sm text-gray-400">
                  <span className="animate-pulse">resolving action...</span>
                </div>
              </div>
            )}
          </>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-gray-800">
        <form onSubmit={(e) => { e.preventDefault(); handleSend() }} className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              actionMode || !currentNpc
                ? 'What do you do? (search, pick up, use, examine, hide...)'
                : `Say something to ${currentNpc.name}...`
            }
            className={`flex-1 bg-gray-800 border rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none ${
              actionMode || !currentNpc
                ? 'border-emerald-800 focus:border-emerald-500'
                : 'border-gray-700 focus:border-amber-500'
            }`}
            disabled={chatLoading || actionLoading}
            autoFocus
          />
          <button
            type="submit"
            disabled={!input.trim() || chatLoading || actionLoading}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:bg-gray-700 disabled:text-gray-500 ${
              actionMode || !currentNpc
                ? 'bg-emerald-600 hover:bg-emerald-500'
                : 'bg-amber-600 hover:bg-amber-500'
            }`}
          >
            {actionMode || !currentNpc ? 'Do' : 'Send'}
          </button>
        </form>
      </div>
    </div>
  )
}
