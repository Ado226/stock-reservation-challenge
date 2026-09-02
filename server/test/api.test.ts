import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { get, post, startHarness, stockOf, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => (h = await startHarness()));
afterAll(() => h.close());

describe('GET /products', () => {
  it('expose le stock disponible et la capacite totale', async () => {
    const { status, body } = await get(h.baseUrl, '/products');
    expect(status).toBe(200);
    expect(body.products[0]).toMatchObject({ id: 1, name: 'Laptop Lenovo', quantity: 5, total: 5 });
  });
});

describe('POST /products/:id/reserve', () => {
  it('reserve et decremente le stock', async () => {
    const before = await stockOf(h.baseUrl, 1);
    const { status, body } = await post(h.baseUrl, '/products/1/reserve', { quantity: 2 });
    expect(status).toBe(200);
    expect(body.product.quantity).toBe(before - 2);
  });

  it('refuse une quantite superieure au stock, sans le modifier', async () => {
    const before = await stockOf(h.baseUrl, 3);
    const { status, body } = await post(h.baseUrl, '/products/3/reserve', { quantity: before + 1 });
    expect(status).toBe(409);
    expect(body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await stockOf(h.baseUrl, 3)).toBe(before);
  });

  it('renvoie 404 sur un produit inconnu', async () => {
    const { status, body } = await post(h.baseUrl, '/products/9999/reserve', { quantity: 1 });
    expect(status).toBe(404);
    expect(body.error.code).toBe('PRODUCT_NOT_FOUND');
  });

  it.each([
    ['quantite nulle', { quantity: 0 }],
    ['quantite negative', { quantity: -3 }],
    ['quantite decimale', { quantity: 1.5 }],
    ['quantite non numerique', { quantity: 'deux' }],
    ['champ absent', {}],
    ['cle inconnue', { quantity: 1, price: 0 }],
  ])('rejette %s en 400', async (_label, payload) => {
    const { status, body } = await post(h.baseUrl, '/products/1/reserve', payload);
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejette un JSON malforme en 400', async () => {
    const { status, body } = await post(h.baseUrl, '/products/1/reserve', '{"quantity":');
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejette un id non numerique en 400', async () => {
    const { status } = await post(h.baseUrl, '/products/abc/reserve', { quantity: 1 });
    expect(status).toBe(400);
  });
});

describe('POST /products/:id/release', () => {
  it('rend le stock au pot commun', async () => {
    await post(h.baseUrl, '/products/2/reserve', { quantity: 4 });
    const reserved = await stockOf(h.baseUrl, 2);
    const { status, body } = await post(h.baseUrl, '/products/2/release', { quantity: 4 });
    expect(status).toBe(200);
    expect(body.product.quantity).toBe(reserved + 4);
  });

  it('ne peut pas fabriquer du stock au-dela de la capacite', async () => {
    const { status, body } = await post(h.baseUrl, '/products/2/release', { quantity: 1 });
    expect(status).toBe(409);
    expect(body.error.code).toBe('RELEASE_EXCEEDS_CAPACITY');
  });
});

describe('Idempotence', () => {
  it('rejoue la meme reponse sans decrementer deux fois', async () => {
    const key = 'idem-reserve-0001';
    const before = await stockOf(h.baseUrl, 1);

    const first = await post(h.baseUrl, '/products/1/reserve', { quantity: 1 }, { 'Idempotency-Key': key });
    const second = await post(h.baseUrl, '/products/1/reserve', { quantity: 1 }, { 'Idempotency-Key': key });

    expect(first.status).toBe(200);
    expect(first.headers.get('idempotent-replay')).toBe('false');
    expect(second.status).toBe(200);
    expect(second.headers.get('idempotent-replay')).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(await stockOf(h.baseUrl, 1)).toBe(before - 1);
  });

  it('memorise aussi un refus : le retry rend le meme verdict', async () => {
    const key = 'idem-refus-0001';
    const payload = { quantity: 999 };
    const first = await post(h.baseUrl, '/products/1/reserve', payload, { 'Idempotency-Key': key });
    const second = await post(h.baseUrl, '/products/1/reserve', payload, { 'Idempotency-Key': key });
    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    expect(second.headers.get('idempotent-replay')).toBe('true');
  });

  it('refuse de reutiliser une cle pour une requete differente', async () => {
    const key = 'idem-collision-01';
    await post(h.baseUrl, '/products/1/reserve', { quantity: 1 }, { 'Idempotency-Key': key });
    const { status, body } = await post(h.baseUrl, '/products/1/reserve', { quantity: 2 }, { 'Idempotency-Key': key });
    expect(status).toBe(422);
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});
