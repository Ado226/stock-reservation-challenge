import { useState } from 'react';
import type { Product } from '../api.js';
import { s } from '../labels.js';
import { ref, IDLE } from '../types.js';
import type { Stock } from '../useStock.js';
import { MovementTable } from './MovementTable.js';
import { Stepper } from './Stepper.js';
import { Tally } from './Tally.js';

/**
 * La liste des références. Chaque ligne est un encart : identité et solde à
 * gauche, commandes à droite. Un clic sur la ligne l'ouvre et révèle les
 * mouvements de cette référence — l'historique est là où on l'attend, sur
 * l'article concerné, sans changer d'écran.
 */
export function StockList({ stock }: { stock: Stock }) {
  const [open, setOpen] = useState<number | null>(null);
  const { products } = stock;

  if (products === null) {
    return (
      <ul className="rows" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="row skeleton" />
        ))}
      </ul>
    );
  }

  return (
    <ul className="rows">
      {products.map((product) => (
        <Row
          key={product.id}
          product={product}
          stock={stock}
          expanded={open === product.id}
          onToggle={() => setOpen((c) => (c === product.id ? null : product.id))}
        />
      ))}
    </ul>
  );
}

interface RowProps {
  product: Product;
  stock: Stock;
  expanded: boolean;
  onToggle(): void;
}

function Row({ product, stock, expanded, onToggle }: RowProps) {
  const state = stock.busy[product.id] ?? IDLE;
  const pending = state.reserve || state.release || state.race;
  const soldOut = product.quantity === 0;
  const full = product.quantity === product.total;
  const qty = Math.min(stock.quantities[product.id] ?? 1, Math.max(product.total, 1));
  const note = stock.notes[product.id];
  const held = product.total - product.quantity;
  const history = stock.movements.filter((m) => m.productId === product.id);

  return (
    <li className={`row${soldOut ? ' is-empty' : ''}${expanded ? ' is-open' : ''}`}>
      <div className="row-main">
        {/* Le bouton porte l'identité et le solde : toute cette zone ouvre le détail. */}
        <button
          type="button"
          className="row-identity"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={`detail-${product.id}`}
        >
          <span className="chevron" aria-hidden="true" />
          <span className="identity-text">
            <span className="name">
              {product.name}
              {product.total === 1 && <span className="tag">pièce unique</span>}
            </span>
            <span className="meta">
              réf. {ref(product.id)} · v{product.version}
              {held > 0 && ` · ${held} tenue${s(held)}`}
              {history.length > 0 && ` · ${history.length} mouvement${s(history.length)}`}
            </span>
          </span>
        </button>

        <div className="row-count">
          <Tally available={product.quantity} total={product.total} />
          <span className={`figure${soldOut ? ' is-empty' : ''}`}>
            <b>{product.quantity}</b>
            <span className="of">/ {product.total}</span>
          </span>
        </div>

        <div className="row-actions">
          <Stepper
            id={`q-${product.id}`}
            label={`Quantité pour ${product.name}`}
            value={qty}
            min={1}
            max={Math.max(product.total, 1)}
            disabled={pending}
            onChange={(v) => stock.setQuantity(product.id, v)}
          />
          <button
            type="button"
            className="btn btn-out"
            disabled={pending || soldOut}
            onClick={() => void stock.run('reserve', product)}
          >
            {state.reserve ? 'Réservation…' : `Réserver ${qty}`}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={pending || full}
            onClick={() => void stock.run('release', product)}
          >
            {state.release ? 'Libération…' : 'Libérer'}
          </button>
        </div>
      </div>

      {note && (
        <p className={`note tone-${note.tone}`} aria-live="polite">
          <span className="sigil">{note.sigil}</span>
          <span>{note.text}</span>
        </p>
      )}

      {expanded && (
        <div className="row-detail" id={`detail-${product.id}`}>
          <h3>Mouvements de cette référence</h3>
          <MovementTable
            movements={history}
            empty={
              <>
                Aucun mouvement sur cette référence. Réserve une unité : la ligne s'inscrit ici
                avec son solde.
              </>
            }
          />
        </div>
      )}
    </li>
  );
}
