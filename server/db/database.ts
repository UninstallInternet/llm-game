import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { WorldState, Player, ConversationTurn } from '../../shared/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(path.join(__dirname, '../../game.db'))
    db.pragma('journal_mode = WAL')

    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8')
    db.exec(schema)
  }
  return db
}

export function saveGame(
  id: string,
  name: string,
  worldState: WorldState,
  playerState: Player
): void {
  const db = getDb()
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO game_saves (id, name, world_state, player_state, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `)
  stmt.run(id, name, JSON.stringify(worldState), JSON.stringify(playerState))
}

export function loadGame(id: string): { world: WorldState; player: Player } | null {
  const db = getDb()
  const row = db.prepare('SELECT world_state, player_state FROM game_saves WHERE id = ?').get(id) as
    | { world_state: string; player_state: string }
    | undefined

  if (!row) return null
  return {
    world: JSON.parse(row.world_state),
    player: JSON.parse(row.player_state),
  }
}

export function listSaves(): Array<{ id: string; name: string; updatedAt: string }> {
  const db = getDb()
  return db
    .prepare('SELECT id, name, updated_at as updatedAt FROM game_saves ORDER BY updated_at DESC')
    .all() as Array<{ id: string; name: string; updatedAt: string }>
}

export function saveConversationTurn(
  saveId: string,
  npcId: string,
  turn: ConversationTurn
): void {
  const db = getDb()
  db.prepare(
    'INSERT INTO conversation_logs (save_id, npc_id, role, content, tick) VALUES (?, ?, ?, ?, ?)'
  ).run(saveId, npcId, turn.role, turn.content, turn.tick)
}

export function getConversationHistory(
  saveId: string,
  npcId: string,
  limit = 20
): ConversationTurn[] {
  const db = getDb()
  const rows = db
    .prepare(
      'SELECT role, content, tick FROM conversation_logs WHERE save_id = ? AND npc_id = ? ORDER BY id DESC LIMIT ?'
    )
    .all(saveId, npcId, limit) as ConversationTurn[]

  return rows.reverse()
}
