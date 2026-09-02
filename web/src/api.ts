export interface Product {
  id: number;
  name: string;
  quantity: number;
  total: number;
  version: number;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export type Operation = 'reserve' | 'release';

export type MutationResult =
  | { ok: true; product: Product; quantity: number; operation: Operation; replayed: boolean }
  | { ok: false; status: number; error: ApiError };

const BASE = '/api';

/**
 * Identite du client, stable pour l'onglet. Elle cloisonne les cles
 * d'idempotence cote serveur : deux navigateurs peuvent utiliser la meme cle
 * sans se voler leur reponse.
 */
const clientId = (() => {
  const stored = sessionStorage.getItem('clientId');
  if (stored) return stored;
  const fresh = `web-${crypto.randomUUID()}`;
  sessionStorage.setItem('clientId', fresh);
  return fresh;
})();

export async function fetchProducts(): Promise<Product[]> {
  const res = await fetch(`${BASE}/products`, { headers: { 'X-Client-Id': clientId } });
  if (!res.ok) throw new Error('Impossible de charger les produits.');
  const data = (await res.json()) as { products: Product[] };
  return data.products;
}

export async function mutate(
  operation: Operation,
  productId: number,
  quantity: number,
  idempotencyKey: string,
): Promise<MutationResult> {
  const res = await fetch(`${BASE}/products/${productId}/${operation}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      'X-Client-Id': clientId,
    },
    body: JSON.stringify({ quantity }),
  });

  const body = (await res.json().catch(() => ({}))) as any;

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: body.error ?? { code: 'UNKNOWN', message: `Erreur HTTP ${res.status}.` },
    };
  }
  return {
    ok: true,
    product: body.product,
    quantity: body.quantity,
    operation,
    replayed: res.headers.get('Idempotent-Replay') === 'true',
  };
}

/**
 * Deux clients distincts reservent en meme temps le meme article : le cas du
 * jury, rejouable depuis l'interface. Chacun a sa propre cle d'idempotence,
 * sinon le second serait un simple rejeu du premier.
 */
export async function raceReserve(productId: number, quantity: number) {
  const [a, b] = await Promise.all([
    mutate('reserve', productId, quantity, `race-a-${crypto.randomUUID()}`),
    mutate('reserve', productId, quantity, `race-b-${crypto.randomUUID()}`),
  ]);
  return [a, b] as const;
}
