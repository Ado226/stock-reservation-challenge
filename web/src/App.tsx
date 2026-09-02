import { useState } from 'react';
import { ConcurrencyView } from './components/ConcurrencyView.js';
import { MovementsView } from './components/MovementsView.js';
import { StockList } from './components/StockList.js';
import { s } from './labels.js';
import { useStock } from './useStock.js';

const TABS = [
  { id: 'stock', label: 'Stock' },
  { id: 'movements', label: 'Mouvements' },
  { id: 'concurrency', label: 'Concurrence' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function App() {
  const [tab, setTab] = useState<TabId>('stock');
  const stock = useStock();
  const { products, movements, offline } = stock;

  const units = products?.reduce((sum, p) => sum + p.quantity, 0) ?? 0;
  const badge: Partial<Record<TabId, number>> = { movements: movements.length };

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <h1>Réservation de stock</h1>
            <p>
              {products
                ? `${products.length} référence${s(products.length)} · ${units} unité${s(units)} disponible${s(units)}`
                : 'Chargement…'}
            </p>
          </div>

          <nav className="tabs" aria-label="Vues">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`tab${tab === t.id ? ' is-active' : ''}`}
                aria-current={tab === t.id ? 'page' : undefined}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {badge[t.id] ? <span className="badge">{badge[t.id]}</span> : null}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="content">
        {offline && (
          <div className="alert" role="alert">
            <strong>API injoignable.</strong> Démarre le serveur avec{' '}
            <code>cd server &amp;&amp; npm run dev</code>. Si l'API écoute sur un autre port,
            relance le front avec <code>API_URL=http://127.0.0.1:3010 npm run dev</code>.
          </div>
        )}

        {tab === 'stock' && (
          <section className="panel">
            <header className="panel-head">
              <h2>Références</h2>
              <span className="dim">Clique une ligne pour voir ses mouvements</span>
            </header>
            <StockList stock={stock} />
          </section>
        )}

        {tab === 'movements' && <MovementsView stock={stock} />}
        {tab === 'concurrency' && <ConcurrencyView stock={stock} />}
      </main>
    </div>
  );
}
