import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import { insufficientStock, notFound, releaseExceedsCapacity, AppError } from './errors.js';

export interface Product {
  id: number;
  name: string;
  /** Stock disponible a la reservation (c'est le `quantity` de l'enonce). */
  quantity: number;
  /** Capacite totale : borne haute que `release` ne peut jamais depasser. */
  total: number;
  /** Compteur de mutations, utile pour un ETag / verrou optimiste cote client. */
  version: number;
}

/** Resultat d'une operation metier. Les refus ne sont pas des exceptions :
 *  ils font partie du contrat et doivent pouvoir etre memorises (idempotence). */
export type Outcome = { status: number; body: unknown };

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

    // === LE COEUR DU SUJET ===
    // Decrement atomique conditionnel : la garde `available_quantity >= @qty`
    // vit DANS l'UPDATE, pas dans un `if` JavaScript precede d'un SELECT.
    // SQLite evalue la condition et ecrit sous le meme verrou d'ecriture, donc
    // deux requetes concurrentes ne peuvent pas lire toutes les deux "1 dispo".
    // La seconde voit changes === 0 et est refusee.
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
      `INSERT INTO stock_events (product_id, kind, quantity, created_at)
       VALUES (@productId, @kind, @qty, @createdAt)`,
    ),

    findKey: db.prepare<[string], { request_hash: string; status_code: number; response_body: string }>(
      `SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE key = ?`,
    ),
    saveKey: db.prepare(
      `INSERT INTO idempotency_keys (key, endpoint, request_hash, status_code, response_body, created_at)
       VALUES (@key, @endpoint, @hash, @status, @body, @createdAt)`,
    ),
  };

  const list = (): Product[] => stmt.list.all().map(toProduct);

  const mutate = (kind: 'RESERVE' | 'RELEASE', id: number, qty: number): Outcome => {
    const changes =
      kind === 'RESERVE'
        ? stmt.reserve.run({ id, qty }).changes
        : stmt.release.run({ id, qty }).changes;

    if (changes === 0) {
      // Zero ligne touchee : soit le produit n'existe pas, soit la garde a joue.
      const row = stmt.find.get(id);
      const err = !row
        ? notFound(id)
        : kind === 'RESERVE'
          ? insufficientStock(id, qty, row.available_quantity)
          : releaseExceedsCapacity(id, qty, row.total_quantity - row.available_quantity);
      return { status: err.status, body: { error: { code: err.code, message: err.message, details: err.details } } };
    }

    stmt.logEvent.run({ productId: id, kind, qty, createdAt: new Date().toISOString() });
    const product = toProduct(stmt.find.get(id)!);
    return {
      status: 200,
      body: { ok: true, operation: kind.toLowerCase(), quantity: qty, product },
    };
  };

  /**
   * Execute la mutation dans une transaction en ecriture immediate.
   * `immediate` prend le verrou d'ecriture des le BEGIN : pas d'echec tardif
   * d'upgrade lecture -> ecriture quand plusieurs processus partagent le fichier.
   */
  const mutationTx = db.transaction(mutate);
  const runMutation = (kind: 'RESERVE' | 'RELEASE', id: number, qty: number): Outcome =>
    mutationTx.immediate(kind, id, qty);

  /**
   * Meme mutation, mais rejouable : la cle d'idempotence et la reponse sont
   * ecrites dans la MEME transaction que le stock. Un retour de la meme cle
   * renvoie la reponse memorisee sans retoucher le stock.
   * Les refus (409) sont memorises aussi : un retry doit donner le meme verdict.
   */
  const idempotentTx = db.transaction(
    (key: string, endpoint: string, kind: 'RESERVE' | 'RELEASE', id: number, qty: number) => {
      const hash = createHash('sha256').update(JSON.stringify({ endpoint, id, qty })).digest('hex');
      const existing = stmt.findKey.get(key);

      if (existing) {
        if (existing.request_hash !== hash) {
          throw new AppError(
            422,
            'IDEMPOTENCY_KEY_REUSED',
            'Cette cle d\'idempotence a deja servi pour une requete differente.',
          );
        }
        return {
          replayed: true,
          status: existing.status_code,
          body: JSON.parse(existing.response_body) as unknown,
        };
      }

      const outcome = mutate(kind, id, qty);
      stmt.saveKey.run({
        key,
        endpoint,
        hash,
        status: outcome.status,
        body: JSON.stringify(outcome.body),
        createdAt: new Date().toISOString(),
      });
      return { replayed: false, ...outcome };
    },
  );

  const runIdempotentMutation = (
    key: string,
    endpoint: string,
    kind: 'RESERVE' | 'RELEASE',
    id: number,
    qty: number,
  ) => idempotentTx.immediate(key, endpoint, kind, id, qty);

  return { list, find: (id: number) => stmt.find.get(id), runMutation, runIdempotentMutation };
}

export type Repository = ReturnType<typeof createRepository>;
