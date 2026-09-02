import type { Refusal, StockOutcome } from './domain.js';

/**
 * Frontiere transport : traduit une issue du domaine en reponse HTTP.
 * C'est le SEUL endroit du serveur qui connait des codes de statut, ce qui
 * permet au domaine et au repository d'ignorer totalement HTTP.
 */

/** Marque du pluriel : 0 et 1 restent au singulier. */
const s = (n: number) => (n > 1 ? 's' : '');

export interface HttpResponse {
  status: number;
  body: unknown;
}

const REFUSAL_HTTP: {
  [R in Refusal['reason']]: { status: number; message: (r: Extract<Refusal, { reason: R }>, id: number) => string };
} = {
  PRODUCT_NOT_FOUND: {
    status: 404,
    message: (_r, id) => `Produit ${id} introuvable.`,
  },
  INSUFFICIENT_STOCK: {
    // 409 et non 400 : la requete est valide, c'est l'etat de la ressource
    // qui a change. Le client doit pouvoir distinguer "corrige ton payload"
    // de "retente plus tard".
    status: 409,
    message: (r, id) =>
      `Stock insuffisant pour le produit ${id} : ${r.wanted} demandée${s(r.wanted)}, ` +
      `${r.available} disponible${s(r.available)}.`,
  },
  RELEASE_EXCEEDS_CAPACITY: {
    status: 409,
    message: (r, id) =>
      `Liberation impossible pour le produit ${id} : ${r.wanted} demandée${s(r.wanted)}, ` +
      `${r.releasable} liberable${s(r.releasable)}.`,
  },
};

export function presentOutcome(outcome: StockOutcome, productId: number): HttpResponse {
  if (outcome.granted) {
    return {
      status: 200,
      body: {
        ok: true,
        operation: outcome.operation,
        quantity: outcome.quantity,
        product: outcome.product,
      },
    };
  }

  const { refusal } = outcome;
  const mapping = REFUSAL_HTTP[refusal.reason];
  const { reason, ...details } = refusal;

  return {
    status: mapping.status,
    body: {
      error: {
        code: reason,
        message: mapping.message(refusal as never, productId),
        ...(Object.keys(details).length > 0 ? { details } : {}),
      },
    },
  };
}

export const errorBody = (code: string, message: string, details?: unknown) => ({
  error: { code, message, ...(details === undefined ? {} : { details }) },
});
