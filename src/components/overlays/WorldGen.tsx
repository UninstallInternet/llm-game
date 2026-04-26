import { useState } from 'react'
import { useGameStore } from '../../stores/gameStore'
import type { ApiResponse, GameStateResponse } from '../../../shared/types'

const PRESETS = [
  { label: 'Medieval Village', desc: 'A small medieval village nestled in a valley, with a church, tavern, blacksmith, and market. Tensions between the lord\'s loyalists and a growing band of free-thinking merchants. A mysterious death has shaken the community.' },
  { label: 'Space Station', desc: 'A remote space station orbiting a gas giant, home to scientists, miners, and corporate overseers. Resources are dwindling, a section has been sealed off after an incident, and not everyone is who they claim to be.' },
  { label: 'Wild West Town', desc: 'A dusty frontier town in the American West, 1870s. Gold has been found in the nearby hills, drawing prospectors, outlaws, and opportunists. The sheriff just died under suspicious circumstances.' },
  { label: 'Pirate Island', desc: 'A hidden pirate haven on a tropical island. Multiple crews share an uneasy peace, trading and scheming. A legendary treasure map has surfaced, and alliances are shifting.' },
]

export function WorldGen() {
  const [setting, setSetting] = useState('')
  const [npcCount, setNpcCount] = useState(20)
  const [locationCount, setLocationCount] = useState(10)
  const { isGenerating, setGenerating, generationMessages, setGameState, addGenerationMessage } = useGameStore()

  async function handleGenerate() {
    if (!setting.trim()) return
    setGenerating(true)

    try {
      const res = await fetch('/api/game/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settingDescription: setting,
          npcCount,
          locationCount,
        }),
      })
      const json = (await res.json()) as ApiResponse<GameStateResponse>

      if (json.success && json.data) {
        setGameState(json.data.world, json.data.player)
      } else {
        addGenerationMessage(`Error: ${json.error ?? 'Unknown error'}`)
        setGenerating(false)
      }
    } catch (err) {
      addGenerationMessage(`Error: ${err instanceof Error ? err.message : 'Network error'}`)
      setGenerating(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center p-4">
      <div className="max-w-2xl w-full">
        <h1 className="text-4xl font-bold mb-2 text-amber-400">The Unnamed Town</h1>
        <p className="text-gray-400 mb-8">Describe a world, and it will come to life.</p>

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
                rows={5}
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
                  onChange={(e) => setNpcCount(Math.max(5, Math.min(50, parseInt(e.target.value) || 20)))}
                  className="w-20 bg-gray-800 border border-gray-700 rounded p-2 text-center"
                  min={5}
                  max={50}
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Locations</label>
                <input
                  type="number"
                  value={locationCount}
                  onChange={(e) => setLocationCount(Math.max(4, Math.min(20, parseInt(e.target.value) || 10)))}
                  className="w-20 bg-gray-800 border border-gray-700 rounded p-2 text-center"
                  min={4}
                  max={20}
                />
              </div>
            </div>

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
