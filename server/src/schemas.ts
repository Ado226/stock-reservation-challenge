import { z } from 'zod';

/** `:id` d'URL : toujours une chaine, on la contraint a un entier strictement positif. */
export const productIdParam = z.object({
  id: z.coerce.number().int().positive(),
});

/**
 * Corps de /reserve et /release. `.strict()` refuse les cles inconnues :
 * un client qui envoie `{ quantity: 1, price: 0 }` est rejete, pas silencieusement accepte.
 */
export const quantityBody = z
  .object({
    quantity: z.coerce.number().int().positive().max(1_000_000),
  })
  .strict();

/** Cle d'idempotence optionnelle, portee par l'en-tete `Idempotency-Key`. */
export const idempotencyKey = z.string().min(8).max(200).optional();
