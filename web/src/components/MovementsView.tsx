import type { Stock } from '../useStock.js';
import { MovementTable, movementSummary } from './MovementTable.js';

/** Le journal complet, toutes références confondues, avec sa légende. */
export function MovementsView({ stock }: { stock: Stock }) {
  const { movements } = stock;

  return (
    <div className="stack">
      <section className="panel">
        <header className="panel-head">
          <h2>Journal des mouvements</h2>
          {movements.length > 0 && <span className="dim">{movementSummary(movements)}</span>}
        </header>
        <MovementTable
          movements={movements}
          showRef
          empty={
            <>
              Rien encore. Chaque réservation et chaque libération s'inscrit ici, accordée ou
              refusée, avec le solde qui en résulte.
            </>
          }
        />
      </section>

      <section className="panel">
        <header className="panel-head">
          <h2>Comment lire ce journal</h2>
        </header>
        <dl className="legend">
          <div>
            <dt className="legend-out">−1</dt>
            <dd>Sortie de stock : une réservation accordée.</dd>
          </div>
          <div>
            <dt className="legend-in">+1</dt>
            <dd>Entrée : une libération, bornée par la capacité de la référence.</dd>
          </div>
          <div>
            <dt>
              <span className="chip chip-ko">refusée</span>
            </dt>
            <dd>
              L'opération a été rejetée. La ligne reste au journal, sans solde : elle n'a rien
              déplacé.
            </dd>
          </div>
          <div>
            <dt className="dim">rejeu</dt>
            <dd>
              Même clé d'idempotence qu'une requête déjà traitée. La réponse est rejouée, le stock
              n'est pas retouché.
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
