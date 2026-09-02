/**
 * Vocabulaire du domaine. Ce module ne connait ni HTTP, ni Express, ni SQL :
 * il decrit ce qui peut arriver a un stock, pas comment on le raconte au client.
 */

export type Operation = 'reserve' | 'release';

export interface Product {
  id: number;
  name: string;
  /** Stock disponible a la reservation (le `quantity` de l'enonce). */
  quantity: number;
  /** Capacite totale : borne haute que `release` ne peut jamais depasser. */
  total: number;
  /** Compteur de mutations, utilisable comme ETag ou pour un verrou optimiste. */
  version: number;
}

/** Raisons pour lesquelles une operation legitime peut etre refusee. */
export type Refusal =
  | { reason: 'PRODUCT_NOT_FOUND' }
  | { reason: 'INSUFFICIENT_STOCK'; wanted: number; available: number }
  | { reason: 'RELEASE_EXCEEDS_CAPACITY'; wanted: number; releasable: number };

/**
 * Resultat d'une operation de stock. Un refus n'est PAS une exception :
 * c'est une issue prevue du domaine, donc une valeur — ce qui permet de la
 * memoriser (idempotence) sans annuler la transaction qui l'a produite.
 */
export type StockOutcome =
  | { granted: true; operation: Operation; quantity: number; product: Product }
  | { granted: false; operation: Operation; quantity: number; refusal: Refusal };
