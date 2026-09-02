import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openDb } from './db.js';

const port = Number(process.env.PORT ?? 3000);
const dbFile = process.env.DB_FILE ?? fileURLToPath(new URL('../data/stock.db', import.meta.url));

const db = openDb(dbFile);
const app = createApp(db);

const server = app.listen(port, () => {
  console.log(`API stock prete sur http://localhost:${port}`);
  console.log(`  db: ${dbFile}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
