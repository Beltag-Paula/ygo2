// db.js — the SQLite database (Node's built-in node:sqlite, so there is nothing native to compile).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const file = process.env.DB_PATH || path.join(process.cwd(), 'data', 'ygo.db');
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass        TEXT NOT NULL,                -- scrypt: salt:hash (hex)
  avatar      TEXT,                         -- /images/avatar/<file>
  frame       TEXT,                         -- icon frame file name
  pvp_wins    INTEGER NOT NULL DEFAULT 0,
  pvp_losses  INTEGER NOT NULL DEFAULT 0,
  bot_wins    INTEGER NOT NULL DEFAULT 0,
  bot_losses  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,             -- sha256 of the cookie value
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS decks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('classic','modern')),
  main        TEXT NOT NULL,                -- JSON array of passcodes
  extra       TEXT NOT NULL,
  side        TEXT NOT NULL,
  owner       TEXT,                         -- optional duelist portrait key (yugi, kaiba, ...)
  avatar      TEXT,
  frame       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS decks_user ON decks(user_id);

-- Duel invitations. to_id NULL = an open invite link anyone can accept.
CREATE TABLE IF NOT EXISTS invites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  from_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  deck_id     INTEGER REFERENCES decks(id) ON DELETE SET NULL,   -- the sender's deck
  mode        TEXT NOT NULL CHECK (mode IN ('classic','modern')),
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | accepted | declined | cancelled
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS invites_to ON invites(to_id, status);

CREATE TABLE IF NOT EXISTS matches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  p1          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  p2          INTEGER REFERENCES users(id) ON DELETE SET NULL,   -- NULL when p1 played the bot
  bot         TEXT,                                              -- bot duelist name
  mode        TEXT NOT NULL,
  winner      INTEGER REFERENCES users(id) ON DELETE SET NULL,   -- NULL = bot won / draw
  turns       INTEGER,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
`);

export const now = () => Date.now();
export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
