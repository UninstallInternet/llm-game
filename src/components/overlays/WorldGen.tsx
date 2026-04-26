import { useState, useCallback, useEffect } from 'react'
import { useGameStore } from '../../stores/gameStore'
import type { ApiResponse, GameStateResponse } from '../../../shared/types'

const PRESETS = [
  { label: 'Medieval Village', desc: 'A small medieval village with a church, tavern, blacksmith, and market. Tensions between the lord\'s loyalists and free-thinking merchants. A mysterious death has shaken the community.' },
  { label: 'Space Station', desc: 'A remote space station orbiting a gas giant. Scientists, miners, and corporate overseers. Resources dwindling, a section sealed off after an incident, and not everyone is who they claim to be.' },
  { label: 'Wild West Town', desc: 'A dusty frontier town, 1870s. Gold found in nearby hills drawing prospectors, outlaws, and opportunists. The sheriff just died under suspicious circumstances.' },
  { label: 'Pirate Island', desc: 'A hidden pirate haven on a tropical island. Multiple crews share an uneasy peace. A legendary treasure map has surfaced and alliances are shifting.' },
]

interface SaveEntry {
  id: string
  name: string
  updatedAt: string
}

export function WorldGen() {
  const [setting, setSetting] = useState('')
  const [npcCount, setNpcCount] = useState(10)
  const [locationCount, setLocationCount] = useState(6)
  const [error, setError] = useState<string | null>(null)
  const [saves, setSaves] = useState<SaveEntry[]>([])
  const [loadingSave, setLoadingSave] = useState(false)

  const isGenerating = useGameStore((s) => s.isGenerating)
  const generationMessages = useGameStore((s) => s.generationMessages)

  // Fetch saved games on mount
  useEffect(() => {
    fetch('/api/game/saves')
      .then((r) => r.json())
      .then((json: ApiResponse<SaveEntry[]>) => {
        if (json.success && json.data) setSaves(json.data)
      })
      .catch(() => {})
  }, [])

  const handleLoadSave = useCallback(async (saveId: string) => {
    setLoadingSave(true)
    setError(null)
    try {
      const res = await fetch('/api/game/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ saveId }),
      })
      const json = (await res.json()) as ApiResponse<GameStateResponse>
      if (json.success && json.data) {
        useGameStore.getState().setGameState(json.data.world, json.data.player)
      } else {
        setError(json.error ?? 'Failed to load save')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
    }
    setLoadingSave(false)
  }, [])

  const handleGenerate = useCallback(async () => {
    if (!setting.trim()) return
    setError(null)
    const store = useGameStore.getState()
    store.clearGenerationMessages()
    store.setGenerating(true)
    store.addGenerationMessage('Sending request to AI...')

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 120000)

      const response = await fetch('/api/game/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settingDescription: setting, npcCount, locationCount }),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (!response.ok) {
        throw new Error(`Server error ${response.status}`)
      }

      const json = (await response.json()) as ApiResponse<GameStateResponse>

      if (json.success && json.data) {
        useGameStore.getState().setGameState(json.data.world, json.data.player)
        return
      }

      // Fallback: fetch state separately
      useGameStore.getState().addGenerationMessage('Loading world state...')
      const stateRes = await fetch('/api/game/state')
      const stateJson = (await stateRes.json()) as ApiResponse<GameStateResponse>
      if (stateJson.success && stateJson.data) {
        useGameStore.getState().setGameState(stateJson.data.world, stateJson.data.player)
        return
      }

      throw new Error(json.error ?? 'Generation failed')
    } catch (err) {
      // Last resort: check if server has the game anyway
      try {
        const stateRes = await fetch('/api/game/state')
        const stateJson = (await stateRes.json()) as ApiResponse<GameStateResponse>
        if (stateJson.success && stateJson.data) {
          useGameStore.getState().setGameState(stateJson.data.world, stateJson.data.player)
          return
        }
      } catch { /* truly failed */ }

      const msg = err instanceof Error ? err.message : 'Unknown error'
      setError(msg)
      useGameStore.getState().addGenerationMessage(`Failed: ${msg}`)
      useGameStore.getState().setGenerating(false)
    }
  }, [setting, npcCount, locationCount])

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center p-4">
      <div className="max-w-2xl w-full">
        <h1 className="text-4xl font-bold mb-2 text-amber-400">The Unnamed Town</h1>
        <p className="text-gray-400 mb-8">Describe a world, and it will come to life.</p>

        {/* Saved Games */}
        {saves.length > 0 && !isGenerating && (
          <div className="mb-8">
            <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">
              Continue a Game
            </h2>
            <div className="space-y-2">
              {saves.map((save) => (
                <button
                  key={save.id}
                  onClick={() => handleLoadSave(save.id)}
                  disabled={loadingSave}
                  className="w-full text-left p-3 bg-gray-800 rounded-lg hover:bg-gray-700 transition-colors border border-gray-700 flex items-center justify-between disabled:opacity-50"
                >
                  <div>
                    <span className="text-amber-400 font-medium">{save.name}</span>
                    <span className="text-xs text-gray-500 ml-3">
                      {new Date(save.updatedAt).toLocaleDateString()} {new Date(save.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <span className="text-gray-500 text-sm">&rarr;</span>
                </button>
              ))}
            </div>
            <div className="border-t border-gray-800 mt-6 mb-6" />
            <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">
              Or Create a New World
            </h2>
          </div>
        )}

        {!isGenerating ? (
          <>
            <div className="mb-6">
              <label className="block text-sm text-gray-400 mb-2">Quick Presets</label>
              <div className="grid grid-cols-2 gap-2">
                {PRESETS.map((p) => (
                  <button
                    key={p.label}
                    onClick={() => setSetting(p.desc)}
                    className="text-left p-3 bg-gray-800 rounded-lg hover:bg-gray-700 transition-colors border border-gray-700"
                  >
                    <span className="text-amber-400 font-medium">{p.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-4">
              <label className="block text-sm text-gray-400 mb-2">World Description</label>
              <textarea
                value={setting}
                onChange={(e) => setSetting(e.target.value)}
                rows={4}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg p-3 text-gray-100 focus:border-amber-500 focus:outline-none resize-none"
                placeholder="Describe the world you want to explore..."
              />
            </div>

            <div className="flex gap-4 mb-6">
              <div>
                <label className="block text-sm text-gray-400 mb-1">NPCs</label>
                <input
                  type="number"
                  value={npcCount}
                  onChange={(e) => setNpcCount(Math.max(5, Math.min(30, parseInt(e.target.value) || 10)))}
                  className="w-20 bg-gray-800 border border-gray-700 rounded p-2 text-center"
                  min={5}
                  max={30}
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Locations</label>
                <input
                  type="number"
                  value={locationCount}
                  onChange={(e) => setLocationCount(Math.max(3, Math.min(12, parseInt(e.target.value) || 6)))}
                  className="w-20 bg-gray-800 border border-gray-700 rounded p-2 text-center"
                  min={3}
                  max={12}
                />
              </div>
            </div>

            {error && (
              <div className="mb-4 p-3 bg-red-900/30 border border-red-700/50 rounded-lg text-sm text-red-300">
                {error}
              </div>
            )}

            <button
              onClick={handleGenerate}
              disabled={!setting.trim()}
              className="w-full py-3 bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg font-medium transition-colors"
            >
              Generate World
            </button>
          </>
        ) : (
          <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="animate-spin w-5 h-5 border-2 border-amber-400 border-t-transparent rounded-full" />
              <span className="text-amber-400 font-medium">Generating your world...</span>
            </div>
            <p className="text-xs text-gray-500 mb-4">This usually takes 15-40 seconds.</p>
            <div className="space-y-1 text-sm text-gray-400 font-mono">
              {generationMessages.map((msg, i) => (
                <div key={i}>{msg}</div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
