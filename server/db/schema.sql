CREATE TABLE IF NOT EXISTS game_saves (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  world_state TEXT NOT NULL,
  player_state TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  save_id TEXT NOT NULL,
  npc_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tick INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (save_id) REFERENCES game_saves(id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_logs_save_npc
  ON conversation_logs(save_id, npc_id);
