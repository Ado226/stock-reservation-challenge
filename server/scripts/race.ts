/**
 * Preuve de la double reservation en conditions reelles : DEUX PROCESSUS
 * serveur distincts partagent le meme fichier SQLite (comme deux pods derriere
 * un load balancer). A chaque tour, le stock est remis a 1 et les deux
 * instances recoivent simultanement une reservation de 1.
 *
 *   npm run race
 */
import Database from 'better-sqlite3';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUNDS = 20;
const PRODUCT_ID = 4;
const PORTS = [3101, 3102];

const here = fileURLToPath(new URL('.', import.meta.url));
const tsxCli = join(here, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const entry = join(here, '..', 'src', 'index.ts');

const dir = mkdtempSync(join(tmpdir(), 'stock-race-'));
const dbFile = join(dir, 'stock.db');

/** Sous Windows, le fichier reste verrouille un instant apres kill() des enfants. */
const cleanup = () => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    console.log(`(fichier temporaire laisse en place : ${dbFile})`);
  }
};

const waitForHealth = async (port: number) => {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      /* pas encore pret */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Instance ${port} injoignable.`);
};

const children: ChildProcess[] = [];

async function main() {
  console.log(`DB partagee : ${dbFile}\n`);

  for (const port of PORTS) {
    const child = spawn(process.execPath, [tsxCli, entry], {
      env: { ...process.env, PORT: String(port), DB_FILE: dbFile },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    children.push(child);
  }
  await Promise.all(PORTS.map(waitForHealth));
  console.log(`${PORTS.length} instances demarrees sur ${PORTS.join(', ')}\n`);

  // Connexion directe pour reinitialiser le stock entre deux tours.
  const db = new Database(dbFile);
  db.pragma('busy_timeout = 5000');
  const reset = db.prepare(
    'UPDATE products SET available_quantity = 1, total_quantity = 1 WHERE id = ?',
  );
  const readQty = db.prepare<[number], { q: number }>(
    'SELECT available_quantity AS q FROM products WHERE id = ?',
  );

  const reserve = (port: number) =>
    fetch(`http://127.0.0.1:${port}/products/${PRODUCT_ID}/reserve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quantity: 1 }),
    }).then((r) => r.status);

  let anomalies = 0;
  for (let round = 1; round <= ROUNDS; round++) {
    reset.run(PRODUCT_ID);

    const [a, b] = await Promise.all([reserve(PORTS[0]!), reserve(PORTS[1]!)]);
    const granted = [a, b].filter((s) => s === 200).length;
    const stock = readQty.get(PRODUCT_ID)!.q;
    const ok = granted === 1 && stock === 0;
    if (!ok) anomalies++;

    console.log(
      `tour ${String(round).padStart(2)} | A(${PORTS[0]})=${a} B(${PORTS[1]})=${b} | ` +
        `accordees=${granted} stock=${stock} ${ok ? 'OK' : '*** ANOMALIE ***'}`,
    );
  }

  db.close();
  console.log(
    `\n${ROUNDS} tours, ${anomalies} anomalie(s). ` +
      (anomalies === 0
        ? 'Aucune double reservation, aucun stock negatif.'
        : 'Invariant viole : voir ci-dessus.'),
  );
  return anomalies === 0 ? 0 : 1;
}

main()
  .then((code) => {
    for (const c of children) c.kill();
    cleanup();
    process.exit(code);
  })
  .catch((err) => {
    console.error(err);
    for (const c of children) c.kill();
    cleanup();
    process.exit(1);
  });
