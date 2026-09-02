import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { openDb, type Db } from '../src/db.js';

export interface Harness {
  baseUrl: string;
  db: Db;
  close(): void;
  dbFile: string;
}

/** Demarre une instance complete (db temporaire + HTTP sur un port libre). */
export async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'stock-test-'));
  const dbFile = join(dir, 'stock.db');
  const db = openDb(dbFile);
  const server: Server = createApp(db).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    db,
    dbFile,
    close() {
      server.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function post(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

export async function get(baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: (await res.json()) as any };
}

export const stockOf = async (baseUrl: string, id: number) =>
  (await get(baseUrl, '/products')).body.products.find((p: any) => p.id === id).quantity;
