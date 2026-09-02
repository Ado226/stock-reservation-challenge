import type { Operation } from '../api.js';
import { s } from '../labels.js';

export interface Movement {
  id: string;
  at: Date;
  productId: number;
  operation: Operation;
  quantity: number;
  granted: boolean;
  /** Solde après le mouvement, absent si l'opération a été refusée. */
  balance?: number;
  /** Ce qui s'est passé : code de refus, rejeu, ou canal du test de concurrence. */
  note?: string;
}

const time = (d: Date) =>
  d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const ref = (id: number) => String(id).padStart(3, '0');

/**
 * Journal des mouvements, avec solde courant — la colonne qui fait tout
 * l'intérêt d'une fiche de stock. Une réservation refusée reste inscrite,
 * barrée : c'est ce qui rend le test de concurrence lisible.
 */
export function Ledger({ movements }: { movements: Movement[] }) {
  return (
    <section className="ledger" aria-label="Journal des mouvements">
      <h2 className="column-head">
        <span>Mouvements</span>
        <span>{movements.length} ligne{s(movements.length)}</span>
      </h2>

      <div className="ledger-body">
        {movements.length === 0 ? (
          <p className="ledger-empty">
            Aucun mouvement pour l'instant. Réserve une unité : chaque opération s'inscrit ici
            avec son solde, <code>accordée</code> ou <code>refusée</code>.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Heure</th>
                <th scope="col">Réf.</th>
                <th scope="col">Mvt</th>
                <th scope="col" className="num">
                  Solde
                </th>
                <th scope="col">Suite</th>
              </tr>
            </thead>
            <tbody aria-live="polite">
              {movements.map((m) => (
                <tr
                  key={m.id}
                  className={`${m.granted ? 'granted' : 'refused'} mv-${m.operation}`}
                >
                  <td>{time(m.at)}</td>
                  <td>{ref(m.productId)}</td>
                  <td className="mv">
                    {m.operation === 'reserve' ? '−' : '+'}
                    {m.quantity}
                  </td>
                  <td className="num">{m.balance ?? '—'}</td>
                  <td className="label">{m.note ?? (m.granted ? 'accordée' : 'refusée')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
