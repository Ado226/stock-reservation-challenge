import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchProducts,
  mutate,
  raceReserve,
  type MutationResult,
  type Operation,
  type Product,
} from './api.js';

type Feedback = { tone: 'ok' | 'ko' | 'info'; text: string };
type Busy = { reserve: boolean; release: boolean; race: boolean };

const IDLE: Busy = { reserve: false, release: false, race: false };

export function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [feedback, setFeedback] = useState<Record<number, Feedback>>({});
  const [busy, setBusy] = useState<Record<number, Busy>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  /**
   * Une cle d'idempotence par intention utilisateur, conservee tant qu'aucune
   * reponse definitive n'est arrivee. Un double-clic ou un retry apres timeout
   * rejoue donc la meme cle et le serveur ne decremente qu'une fois.
   */
  const keys = useRef<Map<string, string>>(new Map());
  const intentKey = (op: Operation, id: number, qty: number) => {
    const slot = `${op}:${id}:${qty}`;
    const existing = keys.current.get(slot);
    if (existing) return { slot, key: existing };
    const fresh = crypto.randomUUID();
    keys.current.set(slot, fresh);
    return { slot, key: fresh };
  };

  const setBusyFlag = (id: number, field: keyof Busy, value: boolean) =>
    setBusy((b) => ({ ...b, [id]: { ...(b[id] ?? IDLE), [field]: value } }));

  const reload = useCallback(async () => {
    try {
      setProducts(await fetchProducts());
      setLoadError(null);
    } catch {
      setLoadError('API injoignable : lance le serveur (npm run dev dans server/).');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const describe = (r: MutationResult): Feedback => {
    if (!r.ok) {
      const suffix = r.status === 429 ? ' (quota atteint)' : '';
      return { tone: 'ko', text: `${r.error.message} [${r.error.code}]${suffix}` };
    }
    return {
      tone: 'ok',
      text: r.replayed
        ? `Requete rejouee (idempotence) : aucun mouvement de stock. Disponible : ${r.product.quantity}.`
        : `${r.operation === 'reserve' ? 'Reserve' : 'Libere'} : ${r.quantity}. Disponible : ${r.product.quantity}.`,
    };
  };

  const run = async (operation: Operation, product: Product) => {
    const qty = Number(quantities[product.id] ?? '1');

    if (!Number.isInteger(qty) || qty <= 0) {
      setFeedback((f) => ({
        ...f,
        [product.id]: { tone: 'ko', text: 'Saisis un entier strictement positif.' },
      }));
      return;
    }

    const { slot, key } = intentKey(operation, product.id, qty);
    setBusyFlag(product.id, operation, true);
    try {
      const result = await mutate(operation, product.id, qty, key);
      setFeedback((f) => ({ ...f, [product.id]: describe(result) }));
      // Reponse definitive : l'intention est consommee, la suivante aura sa cle.
      keys.current.delete(slot);
      await reload();
    } catch {
      // Echec reseau : on GARDE la cle, pour que le retry soit un rejeu.
      setFeedback((f) => ({
        ...f,
        [product.id]: {
          tone: 'ko',
          text: 'Erreur reseau. Reessaie : la requete est idempotente, elle ne comptera pas deux fois.',
        },
      }));
    } finally {
      setBusyFlag(product.id, operation, false);
    }
  };

  const runRace = async (product: Product) => {
    setBusyFlag(product.id, 'race', true);
    try {
      const [a, b] = await raceReserve(product.id, 1);
      const granted = [a, b].filter((r) => r.ok).length;
      const detail = [a, b]
        .map((r, i) => `${i === 0 ? 'A' : 'B'}=${r.ok ? 200 : r.status}`)
        .join('  ');
      setFeedback((f) => ({
        ...f,
        [product.id]: {
          tone: granted === 1 ? 'info' : 'ko',
          text:
            product.quantity === 1
              ? `2 clients simultanes sur 1 article : ${granted} accordee, ${2 - granted} refusee.  ${detail}` +
                (granted === 1 ? '' : '   *** INVARIANT VIOLE ***')
              : `2 clients simultanes : ${granted} accordee(s).  ${detail}`,
        },
      }));
      await reload();
    } finally {
      setBusyFlag(product.id, 'race', false);
    }
  };

  return (
    <main>
      <header>
        <h1>Reservation de stock</h1>
        <p className="sub">
          Le stock disponible est garanti par un decrement atomique conditionnel en base :
          <code> UPDATE ... WHERE available_quantity &gt;= :qty</code>.
        </p>
      </header>

      {loadError && <p className="banner ko">{loadError}</p>}

      <ul className="grid">
        {products.map((product) => {
          const qty = quantities[product.id] ?? '1';
          const fb = feedback[product.id];
          const state = busy[product.id] ?? IDLE;
          const pending = state.reserve || state.release;
          const soldOut = product.quantity === 0;
          const full = product.quantity === product.total;

          return (
            <li key={product.id} className="card">
              <div className="card-head">
                <h2>{product.name}</h2>
                <span className={`badge ${soldOut ? 'zero' : ''}`}>
                  {product.quantity} / {product.total} disponible(s)
                </span>
              </div>

              <div className="row">
                <label htmlFor={`q-${product.id}`}>Quantite</label>
                <input
                  id={`q-${product.id}`}
                  type="number"
                  min={1}
                  step={1}
                  value={qty}
                  onChange={(e) => setQuantities((q) => ({ ...q, [product.id]: e.target.value }))}
                />
                <span className="version">v{product.version}</span>
              </div>

              <div className="actions">
                <button
                  type="button"
                  disabled={pending || soldOut}
                  onClick={() => void run('reserve', product)}
                >
                  {state.reserve ? 'Reservation...' : 'Reserver'}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={pending || full}
                  onClick={() => void run('release', product)}
                >
                  {state.release ? 'Liberation...' : 'Liberer'}
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={state.race || soldOut}
                  onClick={() => void runRace(product)}
                  title="Envoie deux reservations de 1 en parallele, avec deux cles distinctes"
                >
                  {state.race ? 'Course en cours...' : 'Tester 2 clients simultanes'}
                </button>
              </div>

              {fb && <p className={`feedback ${fb.tone}`}>{fb.text}</p>}
            </li>
          );
        })}
      </ul>

      <footer>
        <p>
          <strong>Dock USB-C</strong> est a 1 exemplaire : c'est le cas du jury. Clique
          «&nbsp;Tester 2 clients simultanes&nbsp;» dessus — une seule reservation doit passer.
        </p>
      </footer>
    </main>
  );
}
