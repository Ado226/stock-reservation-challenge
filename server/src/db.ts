import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id                 INTEGER PRIMARY KEY,
  name               TEXT    NOT NULL,
  total_quantity     INTEGER NOT NULL CHECK (total_quantity >= 0),
  available_quantity INTEGER NOT NULL CHECK (available_quantity >= 0),
  version            INTEGER NOT NULL DEFAULT 0,
  -- Invariant de base : on ne peut jamais rendre disponible plus que la capacite.
  CHECK (available_quantity <= total_quantity)
);

-- Journal d'audit : toute mutation de stock laisse une trace immuable.
CREATE TABLE IF NOT EXISTS stock_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  kind       TEXT    NOT NULL CHECK (kind IN ('RESERVE', 'RELEASE')),
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  created_at TEXT    NOT NULL
);

-- Idempotence : une cle rejouee renvoie la reponse memorisee, sans re-muter le stock.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT    PRIMARY KEY,
  endpoint      TEXT    NOT NULL,
  request_hash  TEXT    NOT NULL,
  status_code   INTEGER NOT NULL,
  response_body TEXT    NOT NULL,
  created_at    TEXT    NOT NULL
);
`;

const SEED: Array<[number, string, number]> = [
  [1, 'Laptop Lenovo', 5],
  [2, 'Souris Logitech MX', 12],
  [3, 'Ecran Dell 27"', 3],
  [4, 'Dock USB-C (derniere piece)', 1],
];

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });

  const db = new Database(file);
  // WAL + busy_timeout : plusieurs processus peuvent partager le meme fichier
  // sans qu'un writer concurrent echoue immediatement en SQLITE_BUSY.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);

  const insert = db.prepare(
    `INSERT INTO products (id, name, total_quantity, available_quantity)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  );
  const seed = db.transaction(() => {
    for (const [id, name, qty] of SEED) insert.run(id, name, qty, qty);
  });
  seed();

  return db;
}
