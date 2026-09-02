/** Marque du pluriel français : 0 et 1 restent au singulier. */
export const s = (n: number) => (n > 1 ? 's' : '');

/**
 * Les codes d'erreur de l'API sont faits pour les machines. Le journal est lu
 * par un humain : on traduit, sans jamais inventer d'information.
 */
const REFUSALS: Record<string, string> = {
  insufficient_stock: 'stock épuisé',
  product_not_found: 'référence inconnue',
  release_exceeds_capacity: 'capacité dépassée',
  validation_error: 'requête invalide',
  idempotency_key_reused: 'clé déjà utilisée',
  rate_limited: 'quota atteint',
  internal_error: 'erreur serveur',
};

export const refusalLabel = (code: string) =>
  REFUSALS[code.toLowerCase()] ?? code.toLowerCase().replace(/_/g, ' ');
