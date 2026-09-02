/**
 * Légende de la fiche. Elle occupe le bas de la colonne du journal et rend le
 * code couleur lisible sans avoir à le deviner : sur une fiche de stock, le
 * rouge est une sortie et l'encre une entrée.
 */
export function Conventions() {
  return (
    <section className="conventions" aria-label="Conventions de lecture">
      <h2 className="column-head">
        <span>Conventions</span>
      </h2>
      <dl>
        <div>
          <dt>
            <span className="pip" />
            <span className="pip is-held" />
          </dt>
          <dd>Une pastille par unité : pleine si disponible, barrée si tenue.</dd>
        </div>
        <div>
          <dt className="swatch-out">−1</dt>
          <dd>Sortie de stock — une réservation accordée.</dd>
        </div>
        <div>
          <dt className="swatch-in">+1</dt>
          <dd>Entrée — une libération, bornée par la capacité de la référence.</dd>
        </div>
        <div>
          <dt className="swatch-struck">1</dt>
          <dd>Barré : refusée. La ligne reste au journal, sans mouvement de solde.</dd>
        </div>
        <div>
          <dt className="swatch-probe">v3</dt>
          <dd>Compteur de mutations. Un rejeu idempotent le laisse inchangé.</dd>
        </div>
      </dl>
    </section>
  );
}
