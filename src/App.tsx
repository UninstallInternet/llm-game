import { useGameStore } from './stores/gameStore'
import { useSSE } from './hooks/useSSE'
import { WorldGen } from './components/overlays/WorldGen'
import { GameLayout } from './components/layout/GameLayout'

function App() {
  const world = useGameStore((s) => s.world)

  useSSE()

  if (!world) {
    return <WorldGen />
  }

  return <GameLayout />
}

export default App
