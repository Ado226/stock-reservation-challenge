import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openDb } from './db.js';

const port = Number(process.env.PORT ?? 3000);
const dbFile = process.env.DB_FILE ?? fileURLToPath(new URL('../data/stock.db', import.meta.url));

const db = openDb(dbFile);
const app = createApp(db, {
  corsOrigins: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : '*',
  rateLimitPerMinute: process.env.RATE_LIMIT ? Number(process.env.RATE_LIMIT) : undefined,
});

const server = app.listen(port, () => {
  console.log(`API stock prete sur http://localhost:${port}`);
  console.log(`  db: ${dbFile}`);
});

// Sans ce handler, un port occupe se solde par un "Unhandled error event"
// et une stack trace illisible. On veut un diagnostic exploitable.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Le port ${port} est deja utilise. Relance avec PORT=<autre port>.`);
  } else {
    console.error(`Impossible de demarrer le serveur : ${err.message}`);
  }
  db.close();
  process.exit(1);
});

/** Arret propre : on cesse d'accepter, on laisse finir, puis on ferme la base. */
const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Filet : si une connexion keep-alive traine, on ne bloque pas indefiniment.
  setTimeout(() => process.exit(0), 5000).unref();
};

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
