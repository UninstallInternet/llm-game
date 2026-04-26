import { useRef, useEffect } from 'react'
import { useGameStore } from '../../stores/gameStore'

export function EventLog() {
  const eventLog = useGameStore((s) => s.eventLog)
  const logEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [eventLog.length])

  return (
    <div className="h-64 flex flex-col shrink-0">
      <div className="p-3 border-b border-gray-800">
        <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider">
          Events
        </h3>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {eventLog.length === 0 && (
          <p className="text-xs text-gray-600 text-center py-4">Events will appear here...</p>
        )}
        {eventLog.map((entry, i) => (
          <div key={i} className="text-xs text-gray-400 leading-relaxed">
            <span className="text-gray-600">
              {new Date(entry.timestamp).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>{' '}
            {entry.message}
          </div>
        ))}
        <div ref={logEndRef} />
      </div>
    </div>
  )
}
