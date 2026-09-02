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

export type MutationResult =
  | { ok: true; product: Product; quantity: number; operation: 'reserve' | 'release'; replayed: boolean }
  | { ok: false; error: ApiError; status: number };

const BASE = '/api';

export async function fetchProducts(): Promise<Product[]> {
  const res = await fetch(`${BASE}/products`);
  if (!res.ok) throw new Error('Impossible de charger les produits.');
  const data = (await res.json()) as { products: Product[] };
  return data.products;
}

export async function mutate(
  operation: 'reserve' | 'release',
  productId: number,
  quantity: number,
  idempotencyKey: string,
): Promise<MutationResult> {
  const res = await fetch(`${BASE}/products/${productId}/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ quantity }),
  });
  const body = (await res.json()) as any;

  if (!res.ok) return { ok: false, error: body.error as ApiError, status: res.status };
  return {
    ok: true,
    product: body.product,
    quantity: body.quantity,
    operation,
    replayed: res.headers.get('idempotent-replay') === 'true',
  };
}

/** Deux reservations tirees en meme temps sur le meme produit : demo du cas jury. */
export async function raceReserve(productId: number, quantity: number) {
  const [a, b] = await Promise.all([
    mutate('reserve', productId, quantity, crypto.randomUUID()),
    mutate('reserve', productId, quantity, crypto.randomUUID()),
  ]);
  return [a, b] as const;
}
