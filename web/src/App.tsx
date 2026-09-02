import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchProducts,
  mutate,
  raceReserve,
  type MutationResult,
  type Operation,
  type Product,
} from './api.js';
import { Conventions } from './components/Conventions.js';
import { Ledger, type Movement } from './components/Ledger.js';
import { Stepper } from './components/Stepper.js';
import { Tally } from './components/Tally.js';
import { refusalLabel, s } from './labels.js';

type Note = { tone: 'in' | 'out' | 'probe'; sigil: string; text: string };
type Race = { a: MutationResult; b: MutationResult; stockBefore: number };
type Busy = { reserve: boolean; release: boolean; race: boolean };

const IDLE: Busy = { reserve: false, release: false, race: false };
const ref = (id: number) => String(id).padStart(3, '0');

export function App() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [notes, setNotes] = useState<Record<number, Note>>({});
  const [races, setRaces] = useState<Record<number, Race>>({});
  const [busy, setBusy] = useState<Record<number, Busy>>({});
  const [movements, setMovements] = useState<Movement[]>([]);
  const [offline, setOffline] = useState(false);

  /**
   * Une clé d'idempotence par intention utilisateur, conservée tant qu'aucune
   * réponse définitive n'est arrivée. Un double-clic ou un retry après timeout
   * rejoue donc la même clé, et le serveur ne décrémente qu'une fois.
   */
  const keys = useRef(new Map<string, string>());
  const intentKey = (operation: Operation, id: number, qty: number) => {
    const slot = `${operation}:${id}:${qty}`;
    const existing = keys.current.get(slot);
    if (existing) return { slot, key: existing };
    const fresh = crypto.randomUUID();
    keys.current.set(slot, fresh);
    return { slot, key: fresh };
  };

  const setFlag = (id: number, field: keyof Busy, value: boolean) =>
    setBusy((b) => ({ ...b, [id]: { ...(b[id] ?? IDLE), [field]: value } }));

  const record = (entry: Omit<Movement, 'id' | 'at'>) =>
    setMovements((m) => [{ ...entry, id: crypto.randomUUID(), at: new Date() }, ...m].slice(0, 60));

  const reload = useCallback(async () => {
    try {
      const fresh = await fetchProducts();
      setProducts(fresh);
      setQuantities((q) => {
        const next = { ...q };
        for (const p of fresh) next[p.id] = Math.min(Math.max(next[p.id] ?? 1, 1), Math.max(p.quantity, 1));
        return next;
      });
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (operation: Operation, product: Product) => {
    const qty = quantities[product.id] ?? 1;
    const { slot, key } = intentKey(operation, product.id, qty);
    setFlag(product.id, operation, true);
    setRaces((r) => {
      const { [product.id]: _cleared, ...rest } = r;
      return rest;
    });

    try {
      const result = await mutate(operation, product.id, qty, key);
      keys.current.delete(slot);

      if (result.ok) {
        record({
          productId: product.id,
          operation,
          quantity: qty,
          granted: true,
          balance: result.product.quantity,
          note: result.replayed ? 'rejeu · idempotence' : undefined,
        });
        setNotes((n) => ({
          ...n,
          [product.id]: result.replayed
            ? {
                tone: 'probe',
                sigil: '=',
                text: `Requête rejouée : la même clé d'idempotence, donc aucun second mouvement. Solde inchangé à ${result.product.quantity}.`,
              }
            : {
                tone: operation === 'reserve' ? 'out' : 'in',
                sigil: operation === 'reserve' ? `−${qty}` : `+${qty}`,
                text:
                  operation === 'reserve'
                    ? `${qty} unité${s(qty)} réservée${s(qty)}. Il reste ${result.product.quantity} sur ${result.product.total}.`
                    : `${qty} unité${s(qty)} remise${s(qty)} en rayon. Disponible : ${result.product.quantity} sur ${result.product.total}.`,
              },
        }));
      } else {
        record({
          productId: product.id,
          operation,
          quantity: qty,
          granted: false,
          note: refusalLabel(result.error.code),
        });
        setNotes((n) => ({ ...n, [product.id]: { tone: 'out', sigil: '!', text: result.error.message } }));
      }
      await reload();
    } catch {
      // Échec réseau : on GARDE la clé, pour que le retry soit un rejeu.
      setNotes((n) => ({
        ...n,
        [product.id]: {
          tone: 'out',
          sigil: '!',
          text: 'Le serveur n\'a pas répondu. Relance la même action : elle porte la même clé, elle ne comptera pas deux fois.',
        },
      }));
    } finally {
      setFlag(product.id, operation, false);
    }
  };

  const runRace = async (product: Product) => {
    setFlag(product.id, 'race', true);
    const stockBefore = product.quantity;
    try {
      const [a, b] = await raceReserve(product.id, 1);
      setRaces((r) => ({ ...r, [product.id]: { a, b, stockBefore } }));
      setNotes((n) => {
        const { [product.id]: _drop, ...rest } = n;
        return rest;
      });
      for (const [who, result] of [
        ['client A', a],
        ['client B', b],
      ] as const) {
        record({
          productId: product.id,
          operation: 'reserve',
          quantity: 1,
          granted: result.ok,
          balance: result.ok ? result.product.quantity : undefined,
          note: result.ok ? who : `${who} · ${refusalLabel(result.error.code)}`,
        });
      }
      await reload();
    } catch {
      setNotes((n) => ({
        ...n,
        [product.id]: { tone: 'out', sigil: '!', text: 'Le serveur n\'a pas répondu. Réessaie.' },
      }));
    } finally {
      setFlag(product.id, 'race', false);
    }
  };

  const units = products?.reduce((sum, p) => sum + p.quantity, 0) ?? 0;

  return (
    <div className="shell">
      <header className="masthead">
        <div className="masthead-line">
          <h1>Fiche de stock</h1>
          <span className="count">
            {products
              ? `${products.length} référence${s(products.length)} · ${units} unité${s(units)} disponible${s(units)}`
              : 'chargement…'}
          </span>
        </div>

        <div className="thesis">
          <p>
            Sur le dernier article, deux clients simultanés ne peuvent pas gagner tous les deux.
            La garantie ne tient pas à un verrou en mémoire — elle est{' '}
            <strong>dans la condition de l'écriture</strong>, évaluée par la base sous son verrou.
          </p>
          <pre className="guarantee">
            <code>
              {'UPDATE products\n   SET available_quantity = available_quantity - :qty\n WHERE id = :id\n   '}
              <b>AND available_quantity &gt;= :qty</b>
              {'\n\n-- 1 ligne touchée → accordée   ·   0 ligne → refusée'}
            </code>
          </pre>
        </div>
      </header>

      {offline && (
        <div className="alert" role="alert">
          <h2>API injoignable</h2>
          <p>
            Démarre le serveur : <code>cd server &amp;&amp; npm run dev</code>. Le front interroge{' '}
            <code>/api</code> via le proxy Vite ; si l'API écoute sur un autre port, relance avec{' '}
            <code>API_URL=http://127.0.0.1:3010 npm run dev</code>.
          </p>
        </div>
      )}

      <div className="layout">
        <section aria-label="Références en stock">
          <h2 className="column-head">
            <span>Référence</span>
            <span>Disponible · commande</span>
          </h2>

          {products === null ? (
            <div aria-hidden="true">
              <div className="skeleton" />
              <div className="skeleton" />
              <div className="skeleton" />
            </div>
          ) : (
            <ul className="sheets">
              {products.map((product) => {
                const state = busy[product.id] ?? IDLE;
                const pending = state.reserve || state.release || state.race;
                const soldOut = product.quantity === 0;
                const full = product.quantity === product.total;
                const qty = Math.min(quantities[product.id] ?? 1, Math.max(product.quantity, 1));
                const note = notes[product.id];
                const race = races[product.id];
                const held = product.total - product.quantity;

                return (
                  <li key={product.id} className={`sheet${soldOut ? ' is-empty' : ''}`}>
                    <div className="sheet-head">
                      <h2>{product.name}</h2>
                      <span className="ref">
                        réf. {ref(product.id)} · v{product.version}
                      </span>
                      {product.total === 1 && <span className="last-one">pièce unique</span>}
                    </div>

                    <div className="count-row">
                      <Tally available={product.quantity} total={product.total} />
                      <span className={`balance${soldOut ? ' is-empty' : ''}`}>
                        <b>{product.quantity}</b> / {product.total}
                        {held > 0 && ` · ${held} tenue${s(held)}`}
                      </span>
                    </div>

                    <div className="controls">
                      <label className="ref" htmlFor={`q-${product.id}`}>
                        Quantité
                      </label>
                      <Stepper
                        id={`q-${product.id}`}
                        label={`Quantité pour ${product.name}`}
                        value={qty}
                        min={1}
                        max={Math.max(product.total, 1)}
                        disabled={pending}
                        onChange={(v) => setQuantities((q) => ({ ...q, [product.id]: v }))}
                      />
                      <button
                        type="button"
                        className="act"
                        disabled={pending || soldOut}
                        onClick={() => void run('reserve', product)}
                      >
                        {state.reserve ? 'Réservation…' : `Réserver ${qty}`}
                      </button>
                      <button
                        type="button"
                        className="act act-in"
                        disabled={pending || full}
                        onClick={() => void run('release', product)}
                      >
                        {state.release ? 'Libération…' : `Libérer ${qty}`}
                      </button>
                      <button
                        type="button"
                        className="act act-probe"
                        disabled={pending || soldOut}
                        onClick={() => void runRace(product)}
                        title="Envoie deux réservations de 1 en parallèle, avec deux clés distinctes"
                      >
                        {state.race ? 'Course…' : 'Deux clients à la fois'}
                      </button>
                    </div>

                    {note && (
                      <p className={`note tone-${note.tone}`} aria-live="polite">
                        <span className="sigil">{note.sigil}</span>
                        <span>{note.text}</span>
                      </p>
                    )}

                    {race && <RaceReadout race={race} />}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <div className="aside">
          <Ledger movements={movements} />
          <Conventions />
        </div>
      </div>

      <footer className="colophon">
        <p>
          La référence <strong>004</strong> n'existe qu'en un exemplaire : c'est le cas décisif.
          Lance « Deux clients à la fois » dessus — une seule réservation doit passer, et le
          journal doit montrer une ligne accordée et une ligne barrée, jamais deux accordées.
        </p>
      </footer>
    </div>
  );
}

/** Lecture à deux voies : ce que chaque client a obtenu, et le verdict. */
function RaceReadout({ race }: { race: Race }) {
  const granted = [race.a, race.b].filter((r) => r.ok).length;
  const decisive = race.stockBefore === 1;
  const broken = decisive && granted !== 1;

  return (
    <div className="probe-readout">
      <div className="channels">
        {([['A', race.a], ['B', race.b]] as const).map(([who, result]) => (
          <p key={who} className={`channel ${result.ok ? 'won' : 'lost'}`}>
            <span className="who">Client {who}</span>
            <span>{result.ok ? '200 accordée' : `${result.status} refusée`}</span>
          </p>
        ))}
      </div>
      <p className={`verdict${broken ? ' broken' : ''}`}>
        {broken
          ? `Invariant violé : ${granted} réservations accordées pour 1 article.`
          : decisive
            ? '1 accordée, 1 refusée sur un seul article — invariant tenu.'
            : `${granted} accordée${s(granted)} : le stock suffisait pour les deux. Rejoue sur la réf. 004 pour le cas décisif.`}
      </p>
    </div>
  );
}
