import { useRef, useEffect } from 'react'
import { useGameStore } from '../../stores/gameStore'
import type { DebugEntry } from '../../stores/gameStore'

export function DebugPanel() {
  const debugLog = useGameStore((s) => s.debugLog)
  const lastChatDebug = useGameStore((s) => s.lastChatDebug)
  const logEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [debugLog.length, lastChatDebug])

  return (
    <div className="flex-1 flex flex-col overflow-hidden border-t border-gray-800">
      <div className="p-3 border-b border-gray-800 bg-gray-900/80">
        <h3 className="text-xs font-medium text-purple-400 uppercase tracking-wider">
          Debug: NPC Reasoning
        </h3>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3 text-xs">
        {/* Last player chat debug */}
        {lastChatDebug && (
          <div className="bg-blue-900/20 border border-blue-800/30 rounded p-2">
            <div className="text-blue-400 font-medium mb-1">
              Chat with {lastChatDebug.npcName}
            </div>
            <div className="space-y-1 text-gray-400">
              <div>
                <span className="text-purple-400">Thinking:</span>{' '}
                {lastChatDebug.internalThought}
              </div>
              {lastChatDebug.moodChange && (
                <div>
                  <span className={lastChatDebug.moodChange.delta >= 0 ? 'text-green-400' : 'text-red-400'}>
                    Mood:
                  </span>{' '}
                  {lastChatDebug.moodChange.current} ({lastChatDebug.moodChange.delta >= 0 ? '+' : ''}
                  {lastChatDebug.moodChange.delta}) — {lastChatDebug.moodChange.reason}
                </div>
              )}
              {lastChatDebug.knowledgeGained && lastChatDebug.knowledgeGained.length > 0 && (
                <div>
                  <span className="text-yellow-400">Learned:</span>{' '}
                  {lastChatDebug.knowledgeGained.map((k) => k.content).join('; ')}
                </div>
              )}
              {lastChatDebug.actionAfter && (
                <div>
                  <span className="text-orange-400">Plans to:</span>{' '}
                  {lastChatDebug.actionAfter}
                </div>
              )}
              {lastChatDebug.wantsToEnd && (
                <div className="text-red-400">Wants to end conversation</div>
              )}
            </div>
          </div>
        )}

        {/* Debug log entries */}
        {debugLog.map((entry, i) => (
          <DebugEntryCard key={i} entry={entry} />
        ))}

        {debugLog.length === 0 && !lastChatDebug && (
          <div className="text-gray-600 text-center py-4">
            NPC reasoning will appear here as you play...
          </div>
        )}
        <div ref={logEndRef} />
      </div>
    </div>
  )
}

function DebugEntryCard({ entry }: { entry: DebugEntry }) {
  if (entry.type === 'npc_conversation') {
    const npc1 = entry.data.npc1 as { name: string; thought: string; moodShift: string | null; relDelta: number }
    const npc2 = entry.data.npc2 as { name: string; thought: string; moodShift: string | null; relDelta: number }

    return (
      <div className="bg-amber-900/15 border border-amber-800/30 rounded p-2">
        <div className="text-amber-400 font-medium mb-1">{entry.npcName}</div>
        <div className="text-gray-500 mb-1">{entry.data.summary as string}</div>
        <div className="space-y-1 text-gray-400">
          <NpcThoughtLine name={npc1.name} thought={npc1.thought} mood={npc1.moodShift} relDelta={npc1.relDelta} />
          <NpcThoughtLine name={npc2.name} thought={npc2.thought} mood={npc2.moodShift} relDelta={npc2.relDelta} />
        </div>
      </div>
    )
  }

  if (entry.type === 'player_chat') {
    const d = entry.data as {
      internalThought?: string
      moodChange?: { current: string; delta: number; reason: string } | null
      knowledgeGained?: Array<{ content: string }> | null
      actionAfter?: string | null
    }

    return (
      <div className="bg-blue-900/15 border border-blue-800/30 rounded p-2">
        <div className="text-blue-400 font-medium mb-1">Chat: {entry.npcName}</div>
        <div className="space-y-1 text-gray-400">
          {d.internalThought && (
            <div><span className="text-purple-400">Thought:</span> {d.internalThought}</div>
          )}
          {d.moodChange && (
            <div>
              <span className={d.moodChange.delta >= 0 ? 'text-green-400' : 'text-red-400'}>Mood:</span>{' '}
              {d.moodChange.current} ({d.moodChange.delta >= 0 ? '+' : ''}{d.moodChange.delta})
            </div>
          )}
        </div>
      </div>
    )
  }

  // NPC actions, plans, results
  if (entry.type === 'npc_action') {
    const d = entry.data as Record<string, unknown>

    if (d.plan) {
      return (
        <div className="bg-green-900/15 border border-green-800/30 rounded p-2">
          <div className="text-green-400 font-medium mb-1">Plan: {entry.npcName}</div>
          <div className="text-gray-400">
            <span className="text-green-300">{d.plan as string}</span>
            {' '}[{d.status as string}, {d.steps as number} steps]
          </div>
        </div>
      )
    }

    if (d.outcome) {
      const outcomeColor = d.outcome === 'strong_success' ? 'text-green-400' : d.outcome === 'partial_success' ? 'text-yellow-400' : 'text-red-400'
      return (
        <div className="bg-gray-800/50 border border-gray-700/30 rounded p-2">
          <div className="text-gray-300 font-medium mb-1">{entry.npcName}</div>
          <div className="text-gray-400">
            <span className={outcomeColor}>[{d.outcome as string}]</span> {d.description as string}
          </div>
        </div>
      )
    }

    return (
      <div className="bg-gray-800/50 border border-gray-700/30 rounded p-2">
        <div className="text-gray-300 font-medium mb-1">{entry.npcName}</div>
        <div className="text-gray-400">{d.description as string}</div>
      </div>
    )
  }

  return null
}

function NpcThoughtLine({ name, thought, mood, relDelta }: {
  name: string; thought: string; mood: string | null; relDelta: number
}) {
  return (
    <div className="pl-2 border-l border-gray-700">
      <span className="text-gray-300">{name}:</span>{' '}
      <span className="text-purple-300">{thought}</span>
      {mood && <span className="text-gray-500"> [{mood}]</span>}
      {relDelta !== 0 && (
        <span className={relDelta > 0 ? ' text-green-500' : ' text-red-500'}>
          {' '}rel:{relDelta > 0 ? '+' : ''}{relDelta}
        </span>
      )}
    </div>
  )
}
