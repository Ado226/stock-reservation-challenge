import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import type { Db } from './db.js';
import { AppError } from './errors.js';
import { createRepository } from './repository.js';
import { idempotencyKey, productIdParam, quantityBody } from './schemas.js';

export function createApp(db: Db) {
  const repo = createRepository(db);
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '8kb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.get('/products', (_req, res) => {
    res.json({ products: repo.list() });
  });

  const handleMutation =
    (kind: 'RESERVE' | 'RELEASE', endpoint: string) =>
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = productIdParam.parse(req.params);
        const { quantity } = quantityBody.parse(req.body ?? {});
        const key = idempotencyKey.parse(req.header('Idempotency-Key') ?? undefined);

        if (!key) {
          const { status, body } = repo.runMutation(kind, id, quantity);
          return res.status(status).json(body);
        }

        const { status, body, replayed } = repo.runIdempotentMutation(
          key,
          endpoint,
          kind,
          id,
          quantity,
        );
        res.setHeader('Idempotent-Replay', String(replayed));
        return res.status(status).json(body);
      } catch (err) {
        return next(err);
      }
    };

  app.post('/products/:id/reserve', handleMutation('RESERVE', 'reserve'));
  app.post('/products/:id/release', handleMutation('RELEASE', 'release'));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route inconnue.' } });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Requete invalide.',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }
    if (err instanceof AppError) {
      return res
        .status(err.status)
        .json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    // Corps JSON malforme : express.json leve une SyntaxError portant `body`.
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'JSON malforme.' } });
    }
    console.error('[unhandled]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Erreur interne.' } });
  });

  return app;
}
