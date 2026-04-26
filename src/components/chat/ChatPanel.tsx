import { useState, useRef, useEffect } from 'react'
import { useGameStore } from '../../stores/gameStore'
import { useChat } from '../../hooks/useChat'

export function ChatPanel() {
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const currentNpc = useGameStore((s) => s.currentNpc)
  const player = useGameStore((s) => s.player)
  const chatLoading = useGameStore((s) => s.chatLoading)
  const { sendMessage } = useChat()

  const conversation = currentNpc && player ? player.conversationHistory[currentNpc.id] ?? [] : []

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [conversation.length, chatLoading])

  async function handleSend() {
    if (!input.trim() || !currentNpc || chatLoading) return
    const msg = input.trim()
    setInput('')
    await sendMessage(currentNpc.id, msg)
  }

  if (!currentNpc) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600">
        <div className="text-center">
          <div className="text-4xl mb-3">&#x1F5E3;</div>
          <p>Select someone to talk to from the NPCs panel</p>
          <p className="text-sm text-gray-700 mt-1">or explore the connected locations</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col">
      {/* NPC Header */}
      <div className="p-3 border-b border-gray-800 bg-gray-900/50 flex items-center justify-between">
        <div>
          <span className="font-medium text-amber-400">{currentNpc.name}</span>
          <span className="text-sm text-gray-500 ml-2">
            {currentNpc.occupation}, age {currentNpc.age}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">
            Mood: {currentNpc.mood.current} &middot; Disposition:{' '}
            {dispositionLabel(currentNpc.mood.toward_player)}
          </span>
          <button
            onClick={() => useGameStore.getState().setCurrentNpc(null)}
            className="text-gray-500 hover:text-gray-300 px-2"
          >
            &#x2715;
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {conversation.length === 0 && (
          <div className="text-center text-gray-600 text-sm py-8">
            <p className="text-gray-500 mb-1">{currentNpc.appearance}</p>
            <p>Start a conversation with {currentNpc.name}.</p>
          </div>
        )}
        {conversation.map((turn, i) => (
          <div
            key={i}
            className={`flex ${turn.role === 'player' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-md px-3 py-2 rounded-lg text-sm ${
                turn.role === 'player'
                  ? 'bg-blue-900/50 text-blue-100'
                  : 'bg-gray-800 text-gray-200'
              }`}
            >
              {turn.role === 'npc' && (
                <span className="text-xs text-amber-400 font-medium block mb-1">
                  {currentNpc.name}
                </span>
              )}
              {turn.content}
            </div>
          </div>
        ))}
        {chatLoading && (
          <div className="flex justify-start">
            <div className="bg-gray-800 px-3 py-2 rounded-lg text-sm text-gray-400">
              <span className="text-xs text-amber-400 font-medium block mb-1">
                {currentNpc.name}
              </span>
              <span className="animate-pulse">thinking...</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-gray-800">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleSend()
          }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Say something to ${currentNpc.name}...`}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:border-amber-500 focus:outline-none"
            disabled={chatLoading}
            autoFocus
          />
          <button
            type="submit"
            disabled={!input.trim() || chatLoading}
            className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm font-medium transition-colors"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  )
}

function dispositionLabel(value: number): string {
  if (value <= -60) return 'hostile'
  if (value <= -20) return 'unfriendly'
  if (value <= 20) return 'neutral'
  if (value <= 60) return 'friendly'
  return 'trusting'
}
