import { s } from '../labels.js';
import { ref, type Movement } from '../types.js';

const time = (d: Date) =>
  d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

interface Props {
  movements: Movement[];
  /** Affiche la colonne référence : inutile dans le détail d'une seule fiche. */
  showRef?: boolean;
  empty: React.ReactNode;
}

/**
 * Journal des mouvements avec solde courant. Une opération refusée reste
 * inscrite, barrée, sans solde : c'est ce qui rend le test de concurrence
 * lisible d'un coup d'œil.
 */
export function MovementTable({ movements, showRef = false, empty }: Props) {
  if (movements.length === 0) return <p className="empty">{empty}</p>;

  return (
    <div className="table-scroll">
      <table className="movements">
        <thead>
          <tr>
            <th scope="col">Heure</th>
            {showRef && <th scope="col">Référence</th>}
            <th scope="col" className="num">
              Mvt
            </th>
            <th scope="col" className="num">
              Solde
            </th>
            <th scope="col">Résultat</th>
          </tr>
        </thead>
        <tbody>
          {movements.map((m) => (
            <tr key={m.id} className={`${m.granted ? 'granted' : 'refused'} op-${m.operation}`}>
              <td className="dim">{time(m.at)}</td>
              {showRef && (
                <td>
                  <span className="dim">{ref(m.productId)}</span> {m.productName}
                </td>
              )}
              <td className="num mv">
                {m.operation === 'reserve' ? '−' : '+'}
                {m.quantity}
              </td>
              <td className="num">{m.balance ?? '—'}</td>
              <td>
                <span className={`chip ${m.granted ? 'chip-ok' : 'chip-ko'}`}>
                  {m.granted ? 'accordée' : 'refusée'}
                </span>
                {m.note && <span className="dim note-inline">{m.note}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const movementSummary = (movements: Movement[]) => {
  const granted = movements.filter((m) => m.granted).length;
  const refused = movements.length - granted;
  return `${granted} accordée${s(granted)} · ${refused} refusée${s(refused)}`;
};
