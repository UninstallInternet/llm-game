import { Pool } from 'pg'
import type { WorldState, Player, ConversationTurn } from '../../shared/types.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export async function saveGame(
  id: string,
  name: string,
  worldState: WorldState,
  playerState: Player
): Promise<void> {
  await pool.query(
    `INSERT INTO game_saves (id, name, world_state, player_state, updated_at)
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       world_state = EXCLUDED.world_state,
       player_state = EXCLUDED.player_state,
       updated_at = CURRENT_TIMESTAMP`,
    [id, name, JSON.stringify(worldState), JSON.stringify(playerState)]
  )
}

export async function loadGame(id: string): Promise<{ world: WorldState; player: Player } | null> {
  const result = await pool.query(
    'SELECT world_state, player_state FROM game_saves WHERE id = $1',
    [id]
  )
  const row = result.rows[0] as { world_state: string; player_state: string } | undefined
  if (!row) return null
  return {
    world: JSON.parse(row.world_state),
    player: JSON.parse(row.player_state),
  }
}

export async function listSaves(): Promise<Array<{ id: string; name: string; updatedAt: string }>> {
  const result = await pool.query(
    'SELECT id, name, updated_at AS "updatedAt" FROM game_saves ORDER BY updated_at DESC'
  )
  return result.rows as Array<{ id: string; name: string; updatedAt: string }>
}

export async function saveConversationTurn(
  saveId: string,
  npcId: string,
  turn: ConversationTurn
): Promise<void> {
  await pool.query(
    'INSERT INTO conversation_logs (save_id, npc_id, role, content, tick) VALUES ($1, $2, $3, $4, $5)',
    [saveId, npcId, turn.role, turn.content, turn.tick]
  )
}

export async function getConversationHistory(
  saveId: string,
  npcId: string,
  limit = 20
): Promise<ConversationTurn[]> {
  const result = await pool.query(
    'SELECT role, content, tick FROM conversation_logs WHERE save_id = $1 AND npc_id = $2 ORDER BY id DESC LIMIT $3',
    [saveId, npcId, limit]
  )
  return (result.rows as ConversationTurn[]).reverse()
}
