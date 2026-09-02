import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type AppOptions } from '../src/app.js';
import { openDb, type Db } from '../src/db.js';

export interface Harness {
  baseUrl: string;
  db: Db;
  dbFile: string;
  close(): void;
}

/** Instance complete et isolee : base temporaire + HTTP sur un port libre. */
export async function startHarness(options: AppOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'stock-test-'));
  const dbFile = join(dir, 'stock.db');
  const db = openDb(dbFile);
  const server: Server = createApp(db, options).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    db,
    dbFile,
    close() {
      server.close();
      db.close();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        /* Windows peut garder le fichier verrouille un instant : sans importance. */
      }
    },
  };
}

export interface HttpResult {
  status: number;
  headers: Headers;
  body: any;
}

export async function post(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

export async function get(baseUrl: string, path: string): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, headers: res.headers, body: await res.json() };
}

export const stockOf = async (baseUrl: string, id: number): Promise<number> =>
  (await get(baseUrl, '/products')).body.products.find((p: any) => p.id === id).quantity;
