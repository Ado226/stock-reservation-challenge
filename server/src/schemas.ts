import { z } from 'zod';

/**
 * `:id` d'URL. Un parametre de route est une chaine jusqu'a preuve du
 * contraire : on exige des chiffres et rien d'autre, plutot qu'un `coerce`
 * permissif qui accepterait ` 1 ` ou `1.0`.
 */
export const productIdParam = z.object({
  id: z
    .string()
    .regex(/^\d+$/, 'Doit etre un entier positif.')
    .transform(Number)
    .refine((n) => n >= 1 && Number.isSafeInteger(n), 'Doit etre un entier positif.'),
});

/**
 * Corps de /reserve et /release.
 *
 * Pas de `z.coerce.number()` ici : la coercition accepterait `{"quantity": true}`
 * (Number(true) === 1) et reserverait 1 article sur un booleen. En JSON, une
 * quantite est un nombre — on l'exige.
 *
 * `.strict()` refuse les cles inconnues : `{ quantity: 1, price: 0 }` est rejete,
 * pas silencieusement accepte (pas de mass assignment quand le modele grossira).
 */
export const quantityBody = z
  .object({
    quantity: z
      .number({ invalid_type_error: 'Doit etre un nombre.' })
      .int('Doit etre un entier.')
      .positive('Doit etre strictement positif.')
      .max(1_000_000, 'Quantite hors bornes.'),
  })
  .strict();

/** Cle d'idempotence optionnelle, portee par l'en-tete `Idempotency-Key`. */
export const idempotencyKeyHeader = z
  .string()
  .min(8, 'La cle doit faire au moins 8 caracteres.')
  .max(200)
  .regex(/^[\w.:-]+$/, 'Caracteres autorises : alphanumeriques, . : _ -')
  .optional();

/**
 * Identite du client, portee par `X-Client-Id`. Ce n'est PAS de
 * l'authentification (voir README, section securite) : c'est le point
 * d'ancrage ou une identite verifiee viendra se brancher. Elle sert des
 * maintenant a cloisonner les cles d'idempotence et a tracer l'audit.
 */
export const clientIdHeader = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[\w.:@-]+$/)
  .default('anonymous');
