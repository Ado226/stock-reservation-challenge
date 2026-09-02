import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { ZodError } from 'zod';
import type { Db } from './db.js';
import type { Operation } from './domain.js';
import { errorBody, presentOutcome } from './presenter.js';
import { createRepository, IdempotencyConflict } from './repository.js';
import { clientIdHeader, idempotencyKeyHeader, productIdParam, quantityBody } from './schemas.js';

export interface AppOptions {
  /** Origines autorisees. `'*'` (defaut en dev) accepte tout. */
  corsOrigins?: string[] | '*';
  /** Requetes par fenetre de 60 s et par IP. 0 desactive la limite. */
  rateLimitPerMinute?: number;
  /** Journalisation des requetes. Desactivee sous test. */
  log?: boolean;
}

export function createApp(db: Db, options: AppOptions = {}) {
  const {
    corsOrigins = '*',
    // Volontairement large en dev pour ne pas gener les tests de charge
    // concurrente ; en production, une valeur de l'ordre de 60/min par IP,
    // doublee d'un quota par compte et par produit (voir README).
    rateLimitPerMinute = 1000,
    log = process.env.NODE_ENV !== 'test',
  } = options;

  const repo = createRepository(db);
  const app = express();

  // Derriere un load balancer, `X-Forwarded-For` porte l'IP reelle : sans cela
  // le rate limiting compterait toutes les requetes sur l'IP du proxy.
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

  app.use(helmet());
  app.use(
    cors({
      origin: corsOrigins === '*' ? true : corsOrigins,
      // Sans cette ligne, un client cross-origin ne peut PAS lire l'en-tete :
      // `fetch(...).headers.get('Idempotent-Replay')` renverrait null.
      exposedHeaders: ['Idempotent-Replay', 'X-Request-Id'],
    }),
  );
  app.use(express.json({ limit: '8kb' }));

  // Identifiant de correlation : present dans le log et renvoye au client,
  // pour relier un ticket utilisateur a une ligne de journal.
  app.use((req, res, next) => {
    const requestId = req.header('X-Request-Id') ?? randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    if (!log) return next();

    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      console.log(
        JSON.stringify({
          requestId,
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          durationMs: Number(ms.toFixed(1)),
        }),
      );
    });
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.get('/products', (_req, res) => {
    res.json({ products: repo.list() });
  });

  const mutations = express.Router();
  if (rateLimitPerMinute > 0) {
    mutations.use(
      rateLimit({
        windowMs: 60_000,
        limit: rateLimitPerMinute,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        handler: (_req, res) =>
          res
            .status(429)
            .json(errorBody('RATE_LIMITED', 'Trop de requetes. Reessaie dans un instant.')),
      }),
    );
  }

  const handle =
    (operation: Operation) => (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = productIdParam.parse(req.params);
        const { quantity } = quantityBody.parse(req.body ?? {});
        const key = idempotencyKeyHeader.parse(req.header('Idempotency-Key') ?? undefined);
        const actor = clientIdHeader.parse(req.header('X-Client-Id') ?? undefined);

        if (!key) {
          const outcome = repo.runOperation(operation, id, quantity, actor);
          const { status, body } = presentOutcome(outcome, id);
          return res.status(status).json(body);
        }

        const { replayed, outcome } = repo.runIdempotentOperation(
          actor,
          key,
          operation,
          id,
          quantity,
        );
        const { status, body } = presentOutcome(outcome, id);
        res.setHeader('Idempotent-Replay', String(replayed));
        return res.status(status).json(body);
      } catch (err) {
        return next(err);
      }
    };

  mutations.post('/products/:id/reserve', handle('reserve'));
  mutations.post('/products/:id/release', handle('release'));
  app.use(mutations);

  app.use((_req, res) => {
    res.status(404).json(errorBody('NOT_FOUND', 'Route inconnue.'));
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json(
        errorBody(
          'VALIDATION_ERROR',
          'Requete invalide.',
          err.issues.map((i) => ({ path: i.path.join('.') || '(racine)', message: i.message })),
        ),
      );
    }
    if (err instanceof IdempotencyConflict) {
      // 422 : la requete est bien formee, mais l'intention est contradictoire
      // avec ce que cette cle a deja engage. Deviner serait pire que refuser.
      return res.status(422).json(errorBody('IDEMPOTENCY_KEY_REUSED', err.message));
    }
    // Corps JSON malforme : express.json leve une SyntaxError portant `body`.
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json(errorBody('VALIDATION_ERROR', 'JSON malforme.'));
    }
    // Anomalie non prevue : loguee cote serveur avec sa correlation,
    // jamais renvoyee au client (pas de fuite de stack trace).
    console.error(JSON.stringify({ requestId: res.locals.requestId, error: String(err) }), err);
    return res.status(500).json(errorBody('INTERNAL_ERROR', 'Erreur interne.'));
  });

  return app;
}
