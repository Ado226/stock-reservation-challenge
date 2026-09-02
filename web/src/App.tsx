import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchProducts, mutate, raceReserve, type MutationResult, type Product } from './api.js';

type Feedback = { tone: 'ok' | 'ko' | 'info'; text: string };

export function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [feedback, setFeedback] = useState<Record<number, Feedback>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  /**
   * Une cle d'idempotence par intention utilisateur, conservee tant que la
   * requete n'a pas recu de reponse definitive. Un double-clic ou un retry
   * reseau rejoue la meme cle : le serveur ne decremente qu'une seule fois.
   */
  const keys = useRef<Record<string, string>>({});
  const intentKey = (op: string, id: number, qty: number) => {
    const slot = `${op}:${id}:${qty}`;
    keys.current[slot] ??= crypto.randomUUID();
    return { slot, key: keys.current[slot]! };
  };

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

  const describe = (r: MutationResult): Feedback =>
    r.ok
      ? {
          tone: 'ok',
          text: r.replayed
            ? `Requete rejouee (idempotence) : aucun mouvement de stock. Disponible : ${r.product.quantity}.`
            : `${r.operation === 'reserve' ? 'Reserve' : 'Libere'} : ${r.quantity}. Disponible : ${r.product.quantity}.`,
        }
      : { tone: 'ko', text: `${r.error.message} [${r.error.code}]` };

  const run = async (op: 'reserve' | 'release', product: Product) => {
    const qty = Number(quantities[product.id] ?? '1');

    if (!Number.isInteger(qty) || qty <= 0) {
      setFeedback((f) => ({
        ...f,
        [product.id]: { tone: 'ko', text: 'Saisis un entier strictement positif.' },
      }));
      return;
    }

    const { slot, key } = intentKey(op, product.id, qty);
    setPending((p) => ({ ...p, [slot]: true }));
    try {
      const result = await mutate(op, product.id, qty, key);
      setFeedback((f) => ({ ...f, [product.id]: describe(result) }));
      // Reponse definitive recue : intention consommee, la prochaine aura sa cle.
      delete keys.current[slot];
      await reload();
    } catch {
      // Echec reseau : on garde la cle pour que le retry soit idempotent.
      setFeedback((f) => ({
        ...f,
        [product.id]: { tone: 'ko', text: 'Erreur reseau. Reessaie : la requete est idempotente.' },
      }));
    } finally {
      setPending((p) => ({ ...p, [slot]: false }));
    }
  };

  const runRace = async (product: Product) => {
    const slot = `race:${product.id}`;
    setPending((p) => ({ ...p, [slot]: true }));
    try {
      const [a, b] = await raceReserve(product.id, 1);
      const granted = [a, b].filter((r) => r.ok).length;
      const detail = [a, b].map((r, i) => `${i === 0 ? 'A' : 'B'}=${r.ok ? 200 : r.status}`).join(' ');
      setFeedback((f) => ({
        ...f,
        [product.id]: {
          tone: granted === 1 ? 'info' : 'ko',
          text:
            `2 clients simultanes (1 accordee attendue) : accordees = ${granted}. ${detail}` +
            (granted === 1 ? '' : ' *** INVARIANT VIOLE ***'),
        },
      }));
      await reload();
    } finally {
      setPending((p) => ({ ...p, [slot]: false }));
    }
  };

  return (
    <main>
      <header>
        <h1>Reservation de stock</h1>
        <p className="sub">
          Stock disponible garanti par un decrement atomique conditionnel en base.
        </p>
      </header>

      {loadError && <p className="banner ko">{loadError}</p>}

      <ul className="grid">
        {products.map((product) => {
          const qty = quantities[product.id] ?? '1';
          const fb = feedback[product.id];
          const busy = Object.entries(pending).some(([k, v]) => v && k.includes(`:${product.id}:`));
          const soldOut = product.quantity === 0;

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
              </div>

              <div className="actions">
                <button type="button" disabled={busy || soldOut} onClick={() => void run('reserve', product)}>
                  Reserver
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || product.quantity === product.total}
                  onClick={() => void run('release', product)}
                >
                  Liberer
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={pending[`race:${product.id}`]}
                  onClick={() => void runRace(product)}
                  title="Envoie deux reservations de 1 en parallele"
                >
                  Tester 2 clients simultanes
                </button>
              </div>

              {fb && <p className={`feedback ${fb.tone}`}>{fb.text}</p>}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
