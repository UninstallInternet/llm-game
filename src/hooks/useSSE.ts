import { useEffect, useRef } from 'react'
import type { GameEvent } from '../../shared/types.js'
import { useGameStore } from '../stores/gameStore.js'

export function useSSE(): void {
  const handleGameEvent = useGameStore((s) => s.handleGameEvent)
  const eventSourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    const es = new EventSource('/api/events')
    eventSourceRef.current = es

    es.onmessage = (event) => {
      try {
        const gameEvent = JSON.parse(event.data) as GameEvent
        handleGameEvent(gameEvent)
      } catch {
        // ignore parse errors
      }
    }

    es.onerror = () => {
      // EventSource will auto-reconnect
    }

    return () => {
      es.close()
      eventSourceRef.current = null
    }
  }, [handleGameEvent])
}
