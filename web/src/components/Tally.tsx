/**
 * Les unités, rendues physiquement comptables.
 *
 * C'est le point de l'exercice : « il reste 1 article » ne doit pas être un
 * chiffre qu'on lit, mais une pastille qu'on voit se faire prendre. Au-delà
 * de 24 unités le comptage à l'œil ne veut plus rien dire, on passe à une jauge.
 */

const PIP_LIMIT = 24;

export function Tally({ available, total }: { available: number; total: number }) {
  if (total > PIP_LIMIT) {
    const ratio = total === 0 ? 0 : available / total;
    return (
      <div className="tally-bar" role="img" aria-label={`${available} unités sur ${total}`}>
        <span className="track">
          <span className="fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
        </span>
      </div>
    );
  }

  return (
    <ul className="tally" role="img" aria-label={`${available} unités disponibles sur ${total}`}>
      {Array.from({ length: total }, (_, i) => {
        const held = i >= available;
        // La toute dernière unité disponible passe au rouge : c'est elle que
        // deux clients simultanés vont se disputer.
        const last = !held && available === 1;
        return <li key={i} className={`pip${held ? ' is-held' : ''}${last ? ' is-last' : ''}`} />;
      })}
    </ul>
  );
}
