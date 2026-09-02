import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { post, startHarness, stockOf, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => (h = await startHarness()));
afterAll(() => h.close());

const reserve = (id: number, quantity: number) =>
  post(h.baseUrl, `/products/${id}/reserve`, { quantity });

describe('Probleme senior : 1 article, 2 clients simultanes', () => {
  it('exactement une reservation reussit, l autre est refusee', async () => {
    // Produit 4 : stock initial = 1.
    expect(await stockOf(h.baseUrl, 4)).toBe(1);

    const [a, b] = await Promise.all([reserve(4, 1), reserve(4, 1)]);
    const statuses = [a.status, b.status].sort();

    expect(statuses).toEqual([200, 409]);
    expect(await stockOf(h.baseUrl, 4)).toBe(0);

    const refused = [a, b].find((r) => r.status === 409)!;
    expect(refused.body.error).toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(refused.body.error.details).toEqual({ wanted: 1, available: 0 });

    // Un seul mouvement au journal d'audit : pas de double comptabilisation.
    const events = h.db
      .prepare('SELECT COUNT(*) AS n FROM stock_events WHERE product_id = 4')
      .get() as { n: number };
    expect(events.n).toBe(1);
  });
});

describe('Charge concurrente', () => {
  it('50 clients pour 5 articles : 5 succes, 45 refus, stock final 0', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => reserve(1, 1)));

    const ok = results.filter((r) => r.status === 200).length;
    const refused = results.filter((r) => r.status === 409).length;

    expect(ok).toBe(5);
    expect(refused).toBe(45);
    expect(await stockOf(h.baseUrl, 1)).toBe(0);
  });

  it('quantites melangees : la somme reservee n excede jamais le stock initial', async () => {
    const initial = await stockOf(h.baseUrl, 2); // 12
    const quantities = [5, 5, 5, 3, 3, 2, 2, 1, 1, 1];

    const results = await Promise.all(quantities.map((q) => reserve(2, q)));
    const granted = results
      .map((r, i) => (r.status === 200 ? quantities[i]! : 0))
      .reduce((a, b) => a + b, 0);

    expect(granted).toBeLessThanOrEqual(initial);
    expect(await stockOf(h.baseUrl, 2)).toBe(initial - granted);
    expect(await stockOf(h.baseUrl, 2)).toBeGreaterThanOrEqual(0);
  });

  it('reserve + release entrelaces : le stock reste dans [0, total]', async () => {
    const total = 3; // produit 3
    const ops = Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0 ? reserve(3, 1) : post(h.baseUrl, '/products/3/release', { quantity: 1 }),
    );
    await Promise.all(ops);

    const final = await stockOf(h.baseUrl, 3);
    expect(final).toBeGreaterThanOrEqual(0);
    expect(final).toBeLessThanOrEqual(total);
  });
});

describe('Contre-preuve : pourquoi le SELECT-puis-UPDATE ne suffit pas', () => {
  it('la version naive survend, et c est la contrainte CHECK qui rattrape', () => {
    const db = h.db;
    db.prepare('UPDATE products SET available_quantity = 1 WHERE id = 4').run();

    const readQty = (id: number) =>
      (db.prepare('SELECT available_quantity AS q FROM products WHERE id = ?').get(id) as { q: number })
        .q;
    const blindWrite = (id: number, qty: number) =>
      db
        .prepare('UPDATE products SET available_quantity = available_quantity - ? WHERE id = ?')
        .run(qty, id);

    // Entrelacement realiste d'une implementation naive :
    // A et B lisent tous les deux AVANT que l'un des deux n'ecrive.
    const seenByA = readQty(4);
    const seenByB = readQty(4);
    expect([seenByA, seenByB]).toEqual([1, 1]);

    // Chacun decide en JavaScript : "1 >= 1, je peux reserver".
    expect(seenByA >= 1 && seenByB >= 1).toBe(true);

    blindWrite(4, 1); // A ecrit : stock -> 0
    // B ecrit sur la base de sa lecture perimee : le stock voudrait passer a -1.
    // Sans garde en base, c'est une survente silencieuse ; ici le CHECK la bloque.
    expect(() => blindWrite(4, 1)).toThrow(/CHECK constraint failed/i);
    expect(readQty(4)).toBe(0);

    // L'implementation retenue refuse proprement, sans exception : 0 ligne touchee -> 409.
    const guarded = db
      .prepare(
        'UPDATE products SET available_quantity = available_quantity - ? WHERE id = ? AND available_quantity >= ?',
      )
      .run(1, 4, 1);
    expect(guarded.changes).toBe(0);
    expect(readQty(4)).toBe(0);
  });
});
