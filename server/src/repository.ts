import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import type { Operation, Product, StockOutcome } from './domain.js';

interface ProductRow {
  id: number;
  name: string;
  total_quantity: number;
  available_quantity: number;
  version: number;
}

const toProduct = (row: ProductRow): Product => ({
  id: row.id,
  name: row.name,
  quantity: row.available_quantity,
  total: row.total_quantity,
  version: row.version,
});

/** Rejeu d'une operation deja traitee, ou premiere execution. */
export type IdempotentResult =
  | { replayed: true; outcome: StockOutcome }
  | { replayed: false; outcome: StockOutcome };

/** Levee uniquement en cas d'usage incorrect de l'idempotence par le client. */
export class IdempotencyConflict extends Error {
  constructor() {
    super('Cette cle d idempotence a deja servi pour une requete differente.');
  }
}

export function createRepository(db: Db) {
  const stmt = {
    list: db.prepare<[], ProductRow>(
      `SELECT id, name, total_quantity, available_quantity, version
         FROM products ORDER BY id`,
    ),
    find: db.prepare<[number], ProductRow>(
      `SELECT id, name, total_quantity, available_quantity, version
         FROM products WHERE id = ?`,
    ),

    // ==================== LE COEUR DU SUJET ====================
    // Decrement atomique conditionnel. La garde `available_quantity >= @qty`
    // est evaluee DANS l'UPDATE, sous le verrou d'ecriture : il n'existe aucun
    // instant ou deux requetes peuvent constater "1 disponible" et ecrire
    // toutes les deux. La seconde touche 0 ligne et est refusee.
    reserve: db.prepare(
      `UPDATE products
          SET available_quantity = available_quantity - @qty,
              version            = version + 1
        WHERE id = @id
          AND available_quantity >= @qty`,
    ),

    // Symetrique : on ne peut pas fabriquer du stock a partir de rien.
    release: db.prepare(
      `UPDATE products
          SET available_quantity = available_quantity + @qty,
              version            = version + 1
        WHERE id = @id
          AND available_quantity + @qty <= total_quantity`,
    ),

    logEvent: db.prepare(
      `INSERT INTO stock_events (product_id, kind, quantity, actor, created_at)
       VALUES (@productId, @kind, @qty, @actor, @createdAt)`,
    ),

    findKey: db.prepare<[string, string], { request_hash: string; outcome: string }>(
      `SELECT request_hash, outcome FROM idempotency_keys WHERE actor = ? AND key = ?`,
    ),
    saveKey: db.prepare(
      `INSERT INTO idempotency_keys (actor, key, endpoint, request_hash, outcome, created_at)
       VALUES (@actor, @key, @endpoint, @hash, @outcome, @createdAt)`,
    ),
  };

  const list = (): Product[] => stmt.list.all().map(toProduct);

  /** Une seule ecriture conditionnelle, puis lecture du resultat. Sans exception. */
  const apply = (operation: Operation, id: number, qty: number, actor: string): StockOutcome => {
    const changes =
      operation === 'reserve'
        ? stmt.reserve.run({ id, qty }).changes
        : stmt.release.run({ id, qty }).changes;

    if (changes === 0) {
      // 0 ligne touchee : soit le produit n'existe pas, soit la garde a joue.
      const row = stmt.find.get(id);
      if (!row) {
        return { granted: false, operation, quantity: qty, refusal: { reason: 'PRODUCT_NOT_FOUND' } };
      }
      const refusal =
        operation === 'reserve'
          ? ({
              reason: 'INSUFFICIENT_STOCK',
              wanted: qty,
              available: row.available_quantity,
            } as const)
          : ({
              reason: 'RELEASE_EXCEEDS_CAPACITY',
              wanted: qty,
              releasable: row.total_quantity - row.available_quantity,
            } as const);
      return { granted: false, operation, quantity: qty, refusal };
    }

    stmt.logEvent.run({
      productId: id,
      kind: operation,
      qty,
      actor,
      createdAt: new Date().toISOString(),
    });

    return { granted: true, operation, quantity: qty, product: toProduct(stmt.find.get(id)!) };
  };

  /**
   * `BEGIN IMMEDIATE` : le verrou d'ecriture est pris des l'ouverture, donc pas
   * d'echec tardif d'upgrade lecture -> ecriture quand plusieurs processus
   * partagent le fichier.
   */
  const applyTx = db.transaction(apply);
  const runOperation = (operation: Operation, id: number, qty: number, actor: string) =>
    applyTx.immediate(operation, id, qty, actor);

  /**
   * Meme operation, rejouable. La cle d'idempotence et l'issue du domaine sont
   * ecrites dans LA MEME transaction que le stock : impossible d'avoir un stock
   * mute sans sa cle, ou une cle sans son effet.
   *
   * On memorise l'issue DU DOMAINE, pas une reponse HTTP : la representation
   * transport peut evoluer sans invalider les cles deja enregistrees.
   */
  const idempotentTx = db.transaction(
    (actor: string, key: string, operation: Operation, id: number, qty: number): IdempotentResult => {
      const hash = createHash('sha256')
        .update(JSON.stringify({ operation, id, qty }))
        .digest('hex');

      const existing = stmt.findKey.get(actor, key);
      if (existing) {
        if (existing.request_hash !== hash) throw new IdempotencyConflict();
        return { replayed: true, outcome: JSON.parse(existing.outcome) as StockOutcome };
      }

      const outcome = apply(operation, id, qty, actor);
      stmt.saveKey.run({
        actor,
        key,
        endpoint: operation,
        hash,
        outcome: JSON.stringify(outcome),
        createdAt: new Date().toISOString(),
      });
      return { replayed: false, outcome };
    },
  );

  const runIdempotentOperation = (
    actor: string,
    key: string,
    operation: Operation,
    id: number,
    qty: number,
  ) => idempotentTx.immediate(actor, key, operation, id, qty);

  return { list, runOperation, runIdempotentOperation };
}

export type Repository = ReturnType<typeof createRepository>;
