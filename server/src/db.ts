import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

/**
 * Migrations versionnees, indexees par `PRAGMA user_version`.
 * Chaque etape est jouee une seule fois, dans une transaction, dans l'ordre.
 * On n'edite JAMAIS une etape deja livree : on en ajoute une nouvelle.
 */
const MIGRATIONS: ReadonlyArray<(db: Db) => void> = [
  // 001 — schema initial
  (db) => {
    db.exec(`
      CREATE TABLE products (
        id                 INTEGER PRIMARY KEY,
        name               TEXT    NOT NULL,
        total_quantity     INTEGER NOT NULL CHECK (total_quantity >= 0),
        available_quantity INTEGER NOT NULL CHECK (available_quantity >= 0),
        version            INTEGER NOT NULL DEFAULT 0,
        -- Invariants portes par le schema : ni stock negatif, ni stock inventé.
        CHECK (available_quantity <= total_quantity)
      );

      -- Journal d'audit append-only : toute mutation laisse une trace.
      CREATE TABLE stock_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id),
        kind       TEXT    NOT NULL CHECK (kind IN ('reserve', 'release')),
        quantity   INTEGER NOT NULL CHECK (quantity > 0),
        actor      TEXT,
        created_at TEXT    NOT NULL
      );
      CREATE INDEX idx_stock_events_product ON stock_events (product_id, id);

      -- Memoire des requetes deja traitees, par (client, cle).
      CREATE TABLE idempotency_keys (
        actor        TEXT    NOT NULL,
        key          TEXT    NOT NULL,
        endpoint     TEXT    NOT NULL,
        request_hash TEXT    NOT NULL,
        outcome      TEXT    NOT NULL,
        created_at   TEXT    NOT NULL,
        PRIMARY KEY (actor, key)
      );
      -- Sert la purge par TTL (voir README, ameliorations prod).
      CREATE INDEX idx_idempotency_created_at ON idempotency_keys (created_at);
    `);
  },

  // 002 — libelles accentues (le seed initial etait en ASCII)
  (db) => {
    const rename = db.prepare('UPDATE products SET name = ? WHERE id = ?');
    rename.run('Écran Dell 27\"', 3);
    rename.run('Dock USB-C (dernière pièce)', 4);
  },
];

const SEED: ReadonlyArray<readonly [number, string, number]> = [
  [1, 'Laptop Lenovo', 5],
  [2, 'Souris Logitech MX', 12],
  [3, 'Écran Dell 27"', 3],
  [4, 'Dock USB-C (dernière pièce)', 1],
];

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;

  for (let v = current; v < MIGRATIONS.length; v++) {
    const step = MIGRATIONS[v]!;
    db.transaction(() => {
      step(db);
      // PRAGMA n'accepte pas de parametre lie : la valeur est un entier interne,
      // jamais une donnee utilisateur.
      db.pragma(`user_version = ${v + 1}`);
    }).immediate();
  }
}

function seed(db: Db): void {
  const insert = db.prepare(
    `INSERT INTO products (id, name, total_quantity, available_quantity)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  );
  db.transaction(() => {
    for (const [id, name, qty] of SEED) insert.run(id, name, qty, qty);
  }).immediate();
}

export function openDb(file: string, options: { seed?: boolean } = {}): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });

  const db = new Database(file);
  // WAL : les lecteurs ne bloquent pas l'ecrivain, et plusieurs processus
  // peuvent partager le fichier. busy_timeout : un ecrivain concurrent attend
  // son tour au lieu d'echouer immediatement en SQLITE_BUSY.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // FULL plutot que NORMAL : on ne veut pas perdre une reservation confirmee
  // en cas de coupure. Compromis debit/durabilite assume pour du stock.
  db.pragma('synchronous = FULL');

  migrate(db);
  if (options.seed !== false) seed(db);

  return db;
}
