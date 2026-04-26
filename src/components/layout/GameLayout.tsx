import { useGameStore } from '../../stores/gameStore'
import { LocationPanel } from '../world/LocationPanel'
import { LocationNav } from '../world/LocationNav'
import { ChatPanel } from '../chat/ChatPanel'
import { EventLog } from '../sidebar/EventLog'
import { NPCList } from '../sidebar/NPCList'

export function GameLayout() {
  const world = useGameStore((s) => s.world)
  const player = useGameStore((s) => s.player)

  if (!world || !player) return null

  return (
    <div className="h-screen bg-gray-950 text-gray-100 flex flex-col">
      {/* Header */}
      <header className="bg-gray-900 border-b border-gray-800 px-4 py-2 flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-lg font-bold text-amber-400">{world.name}</h1>
          <span className="text-sm text-gray-400">{world.settingDescription.slice(0, 80)}...</span>
        </div>
        <div className="text-right">
          <div className="text-amber-400 font-mono">
            Day {world.time.day} &middot; {world.time.timeOfDay}
          </div>
          <div className="text-xs text-gray-500">
            {world.npcs.length} characters &middot; {world.locations.length} locations
          </div>
        </div>
      </header>

      {/* Main 3-column layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Location + Navigation */}
        <div className="w-72 bg-gray-900 border-r border-gray-800 flex flex-col overflow-hidden shrink-0">
          <LocationPanel />
          <LocationNav />
        </div>

        {/* Center: Chat */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <ChatPanel />
        </div>

        {/* Right: Event Log + NPC List */}
        <div className="w-80 bg-gray-900 border-l border-gray-800 flex flex-col overflow-hidden shrink-0">
          <NPCList />
          <EventLog />
        </div>
      </div>
    </div>
  )
}
