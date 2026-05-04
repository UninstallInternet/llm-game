import { useEffect, useRef } from 'react'
import type { GameEvent } from '../../shared/types.js'
import { useGameStore } from '../stores/gameStore.js'

export function useSSE(): void {
  const handleGameEvent = useGameStore((s) => s.handleGameEvent)
  const eventSourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    // Pass API token as query param if configured (SSE can't send headers)
    const token = (window as unknown as Record<string, string>).__API_TOKEN__
    const url = token ? `/api/events?token=${encodeURIComponent(token)}` : '/api/events'
    const es = new EventSource(url)
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
