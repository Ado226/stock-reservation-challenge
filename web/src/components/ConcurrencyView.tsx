import type { Product } from '../api.js';
import { s } from '../labels.js';
import { IDLE, ref, type Race } from '../types.js';
import type { Stock } from '../useStock.js';

/**
 * Le cas du sujet, mis en scène : deux clients réservent le dernier article
 * en même temps. Une seule réservation doit passer, et le résultat doit être
 * lisible sans lire le code.
 */
export function ConcurrencyView({ stock }: { stock: Stock }) {
  const { products } = stock;
  const decisive = products?.filter((p) => p.total === 1) ?? [];

  return (
    <div className="stack">
      <section className="panel panel-lead">
        <header className="panel-head">
          <h2>Deux clients, un seul article</h2>
        </header>
        <div className="lead-body">
          <p>
            Chaque test envoie <strong>deux réservations de 1 en parallèle</strong>, avec deux clés
            d'idempotence distinctes — donc deux clients réellement différents, pas un rejeu. Sur une
            référence à un seul exemplaire, une seule doit être accordée.
          </p>
          <pre className="code">
            <code>
              {'UPDATE products\n   SET available_quantity = available_quantity - :qty\n WHERE id = :id\n   '}
              <b>AND available_quantity &gt;= :qty</b>
              {'\n\n-- 1 ligne touchée → accordée   ·   0 ligne → refusée'}
            </code>
          </pre>
          <p className="dim">
            La garde vit dans l'écriture, pas dans un <code>if</code> précédé d'une lecture : il
            n'existe aucun instant où les deux requêtes peuvent constater « 1 disponible ». Aucun
            verrou en mémoire n'est utilisé, donc la garantie tient aussi à plusieurs instances —
            ce que prouve <code>npm run race</code>, côté serveur, sur deux processus distincts.
          </p>
        </div>
      </section>

      {products === null ? (
        <section className="panel skeleton-panel" aria-hidden="true" />
      ) : (
        <>
          {decisive.length > 0 && (
            <section className="panel">
              <header className="panel-head">
                <h2>Références décisives</h2>
                <span className="dim">un seul exemplaire</span>
              </header>
              <ul className="probes">
                {decisive.map((p) => (
                  <Probe key={p.id} product={p} stock={stock} />
                ))}
              </ul>
            </section>
          )}

          <section className="panel">
            <header className="panel-head">
              <h2>Autres références</h2>
              <span className="dim">stock suffisant pour deux</span>
            </header>
            <ul className="probes">
              {products
                .filter((p) => p.total > 1)
                .map((p) => (
                  <Probe key={p.id} product={p} stock={stock} />
                ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function Probe({ product, stock }: { product: Product; stock: Stock }) {
  const state = stock.busy[product.id] ?? IDLE;
  const race = stock.races[product.id];
  const soldOut = product.quantity === 0;

  return (
    <li className="probe">
      <div className="probe-head">
        <span className="identity-text">
          <span className="name">{product.name}</span>
          <span className="meta">
            réf. {ref(product.id)} · {product.quantity} sur {product.total} disponible
            {s(product.quantity)}
          </span>
        </span>
        <div className="probe-actions">
          {soldOut ? (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={state.release}
              onClick={() => void stock.restock(product)}
            >
              {state.release ? 'Remise en stock…' : 'Remettre en stock'}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-probe"
              disabled={state.race}
              onClick={() => void stock.runRace(product)}
            >
              {state.race ? 'Course…' : 'Lancer deux clients'}
            </button>
          )}
        </div>
      </div>

      {race && <Readout race={race} />}
    </li>
  );
}

function Readout({ race }: { race: Race }) {
  const granted = [race.a, race.b].filter((r) => r.ok).length;
  const decisive = race.stockBefore === 1;
  const broken = decisive && granted !== 1;

  return (
    <div className={`readout${broken ? ' is-broken' : ''}`}>
      <div className="channels">
        {([['A', race.a], ['B', race.b]] as const).map(([who, result]) => (
          <div key={who} className={`channel ${result.ok ? 'won' : 'lost'}`}>
            <span className="who">Client {who}</span>
            <span className="verdict-code">{result.ok ? '200' : result.status}</span>
            <span className="verdict-word">{result.ok ? 'accordée' : 'refusée'}</span>
            <span className="dim">
              {result.ok
                ? 'Réservation enregistrée, stock décrémenté.'
                : result.error.message}
            </span>
          </div>
        ))}
      </div>
      <p className="verdict">
        {broken
          ? `Invariant violé : ${granted} réservations accordées pour 1 article.`
          : decisive
            ? 'Une accordée, une refusée sur un seul article — invariant tenu.'
            : `${granted} accordée${s(granted)} : le stock suffisait pour les deux. Le cas décisif est une référence à un seul exemplaire.`}
      </p>
    </div>
  );
}
