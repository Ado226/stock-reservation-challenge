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

  it('renvoie un identifiant de correlation', async () => {
    const { headers } = await get(h.baseUrl, '/products');
    expect(headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reprend l identifiant de correlation fourni par le client', async () => {
    const res = await fetch(`${h.baseUrl}/products`, { headers: { 'X-Request-Id': 'trace-abc' } });
    expect(res.headers.get('x-request-id')).toBe('trace-abc');
  });
});

describe('POST /products/:id/reserve', () => {
  it('reserve et decremente le stock', async () => {
    const before = await stockOf(h.baseUrl, 1);
    const { status, body } = await post(h.baseUrl, '/products/1/reserve', { quantity: 2 });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, operation: 'reserve', quantity: 2 });
    expect(body.product.quantity).toBe(before - 2);
  });

  it('refuse une quantite superieure au stock, sans le modifier', async () => {
    const before = await stockOf(h.baseUrl, 3);
    const { status, body } = await post(h.baseUrl, '/products/3/reserve', { quantity: before + 1 });
    expect(status).toBe(409);
    expect(body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(body.error.details).toEqual({ wanted: before + 1, available: before });
    expect(await stockOf(h.baseUrl, 3)).toBe(before);
  });

  it('renvoie 404 sur un produit inconnu', async () => {
    const { status, body } = await post(h.baseUrl, '/products/9999/reserve', { quantity: 1 });
    expect(status).toBe(404);
    expect(body.error.code).toBe('PRODUCT_NOT_FOUND');
    expect(body.error).not.toHaveProperty('details');
  });
});

describe('Validation des entrees', () => {
  it.each([
    ['quantite nulle', { quantity: 0 }],
    ['quantite negative', { quantity: -3 }],
    ['quantite decimale', { quantity: 1.5 }],
    ['quantite texte', { quantity: 'deux' }],
    // Piege classique : avec z.coerce.number(), Number(true) === 1 et cette
    // requete reserverait 1 article. Le schema exige un vrai nombre.
    ['quantite booleenne', { quantity: true }],
    ['quantite chaine numerique', { quantity: '2' }],
    ['quantite nulle (null)', { quantity: null }],
    ['quantite tableau', { quantity: [1] }],
    ['quantite hors bornes', { quantity: 10_000_000 }],
    ['champ absent', {}],
    ['cle inconnue', { quantity: 1, price: 0 }],
  ])('rejette %s en 400', async (_label, payload) => {
    const before = await stockOf(h.baseUrl, 1);
    const { status, body } = await post(h.baseUrl, '/products/1/reserve', payload);
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(await stockOf(h.baseUrl, 1)).toBe(before);
  });

  it('rejette un JSON malforme en 400', async () => {
    const { status, body } = await post(h.baseUrl, '/products/1/reserve', '{"quantity":');
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it.each(['abc', '1.5', '-1', '0', '1e3'])('rejette l id "%s" en 400', async (id) => {
    const { status, body } = await post(h.baseUrl, `/products/${id}/reserve`, { quantity: 1 });
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejette une cle d idempotence mal formee', async () => {
    const { status } = await post(
      h.baseUrl,
      '/products/1/reserve',
      { quantity: 1 },
      { 'Idempotency-Key': 'court' },
    );
    expect(status).toBe(400);
  });

  it('renvoie 404 sur une route inconnue', async () => {
    const { status, body } = await post(h.baseUrl, '/products/1/buy', { quantity: 1 });
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
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
    expect(body.error.details).toEqual({ wanted: 1, releasable: 0 });
  });

  it('renvoie 404 sur un produit inconnu', async () => {
    const { status, body } = await post(h.baseUrl, '/products/9999/release', { quantity: 1 });
    expect(status).toBe(404);
    expect(body.error.code).toBe('PRODUCT_NOT_FOUND');
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
    // Le `version` identique prouve l'absence de seconde mutation : le stock ne
    // "retombe" pas par coincidence sur la meme valeur.
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
    expect(second.body).toEqual(first.body);
  });

  it('refuse de reutiliser une cle pour une requete differente', async () => {
    const key = 'idem-collision-01';
    await post(h.baseUrl, '/products/1/reserve', { quantity: 1 }, { 'Idempotency-Key': key });
    const { status, body } = await post(
      h.baseUrl,
      '/products/1/reserve',
      { quantity: 2 },
      { 'Idempotency-Key': key },
    );
    expect(status).toBe(422);
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('la meme cle chez deux clients differents reste deux operations distinctes', async () => {
    const key = 'cle-partagee-0001';
    const before = await stockOf(h.baseUrl, 2);

    const a = await post(
      h.baseUrl,
      '/products/2/reserve',
      { quantity: 1 },
      { 'Idempotency-Key': key, 'X-Client-Id': 'client-a' },
    );
    const b = await post(
      h.baseUrl,
      '/products/2/reserve',
      { quantity: 1 },
      { 'Idempotency-Key': key, 'X-Client-Id': 'client-b' },
    );

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.headers.get('idempotent-replay')).toBe('false');
    expect(b.headers.get('idempotent-replay')).toBe('false');
    expect(await stockOf(h.baseUrl, 2)).toBe(before - 2);
  });

  it('trace l auteur de chaque mouvement dans le journal d audit', async () => {
    await post(
      h.baseUrl,
      '/products/3/reserve',
      { quantity: 1 },
      { 'X-Client-Id': 'auditeur-42' },
    );
    const row = h.db
      .prepare('SELECT actor, kind, quantity FROM stock_events WHERE actor = ? ORDER BY id DESC')
      .get('auditeur-42');
    expect(row).toMatchObject({ actor: 'auditeur-42', kind: 'reserve', quantity: 1 });
  });
});

describe('Garde-fous transport', () => {
  it('limite le debit et repond 429 au-dela du quota', async () => {
    const limited = await startHarness({ rateLimitPerMinute: 3 });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        statuses.push((await post(limited.baseUrl, '/products/1/reserve', { quantity: 1 })).status);
      }
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      expect(statuses.slice(3)).toEqual([429, 429]);

      // La lecture reste servie : la limite ne porte que sur les mutations.
      expect((await get(limited.baseUrl, '/products')).status).toBe(200);
    } finally {
      limited.close();
    }
  });

  it('expose les en-tetes personnalises aux clients cross-origin', async () => {
    const res = await fetch(`${h.baseUrl}/products`, { headers: { Origin: 'http://exemple.test' } });
    const exposed = res.headers.get('access-control-expose-headers') ?? '';
    expect(exposed.toLowerCase()).toContain('idempotent-replay');
  });

  it('ne renvoie pas la signature du serveur', async () => {
    const res = await fetch(`${h.baseUrl}/health`);
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});
