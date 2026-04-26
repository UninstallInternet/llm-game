import { useEffect } from 'react'
import { useGameStore } from './stores/gameStore'
import { useSSE } from './hooks/useSSE'
import { WorldGen } from './components/overlays/WorldGen'
import { GameLayout } from './components/layout/GameLayout'
import type { ApiResponse, GameStateResponse } from '../shared/types'

function App() {
  const world = useGameStore((s) => s.world)
  const isLoading = useGameStore((s) => s.isLoading)

  useSSE()

  // On mount, try to load existing game state from server
  useEffect(() => {
    async function tryLoadState() {
      useGameStore.getState().setLoading(true)
      try {
        const res = await fetch('/api/game/state')
        const json = (await res.json()) as ApiResponse<GameStateResponse>
        if (json.success && json.data) {
          useGameStore.getState().setGameState(json.data.world, json.data.player)
        }
      } catch { /* no saved game, show world gen */ }
      useGameStore.getState().setLoading(false)
    }
    tryLoadState()
  }, [])

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full" />
      </div>
    )
  }

  if (!world) {
    return <WorldGen />
  }

  return <GameLayout />
}

export default App
