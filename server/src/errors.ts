export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'PRODUCT_NOT_FOUND'
  | 'INSUFFICIENT_STOCK'
  | 'RELEASE_EXCEEDS_CAPACITY'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (id: number) =>
  new AppError(404, 'PRODUCT_NOT_FOUND', `Produit ${id} introuvable.`);

export const insufficientStock = (id: number, wanted: number, available: number) =>
  new AppError(
    409,
    'INSUFFICIENT_STOCK',
    `Stock insuffisant pour le produit ${id} : ${wanted} demande(s), ${available} disponible(s).`,
    { wanted, available },
  );

export const releaseExceedsCapacity = (id: number, wanted: number, releasable: number) =>
  new AppError(
    409,
    'RELEASE_EXCEEDS_CAPACITY',
    `Liberation impossible pour le produit ${id} : ${wanted} demande(s), ${releasable} liberable(s).`,
    { wanted, releasable },
  );
