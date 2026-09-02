import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchProducts, mutate, raceReserve, type Operation, type Product } from './api.js';
import { refusalLabel, s } from './labels.js';
import { IDLE, type Busy, type Movement, type Note, type Race } from './types.js';

/**
 * Tout l'état et toutes les actions de la console. Isolé du rendu pour que les
 * vues restent purement présentationnelles — et pour que cette logique soit
 * testable sans monter un arbre React.
 */
export function useStock() {
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
    setMovements((m) => [{ ...entry, id: crypto.randomUUID(), at: new Date() }, ...m].slice(0, 120));

  const reload = useCallback(async () => {
    try {
      const fresh = await fetchProducts();
      setProducts(fresh);
      setQuantities((q) => {
        const next = { ...q };
        for (const p of fresh) next[p.id] = Math.min(Math.max(next[p.id] ?? 1, 1), Math.max(p.total, 1));
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

  const setQuantity = (id: number, value: number) =>
    setQuantities((q) => ({ ...q, [id]: value }));

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
          productName: product.name,
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
                text: `Requête rejouée : même clé d'idempotence, donc aucun second mouvement. Solde inchangé à ${result.product.quantity}.`,
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
          productName: product.name,
          operation,
          quantity: qty,
          granted: false,
          note: refusalLabel(result.error.code),
        });
        setNotes((n) => ({
          ...n,
          [product.id]: { tone: 'out', sigil: '!', text: result.error.message },
        }));
      }
      await reload();
    } catch {
      // Échec réseau : on GARDE la clé, pour que le retry soit un rejeu.
      setNotes((n) => ({
        ...n,
        [product.id]: {
          tone: 'out',
          sigil: '!',
          text: "Le serveur n'a pas répondu. Relance la même action : elle porte la même clé, elle ne comptera pas deux fois.",
        },
      }));
    } finally {
      setFlag(product.id, operation, false);
    }
  };

  /**
   * Remet une reference a sa capacite, pour pouvoir rejouer une course sans
   * changer d'onglet. C'est un outil de demonstration, pas une operation
   * metier : il passe par le meme `release` borne par la capacite.
   */
  const restock = async (product: Product) => {
    const missing = product.total - product.quantity;
    if (missing <= 0) return;
    setFlag(product.id, 'release', true);
    try {
      const result = await mutate('release', product.id, missing, crypto.randomUUID());
      if (result.ok) {
        record({
          productId: product.id,
          productName: product.name,
          operation: 'release',
          quantity: missing,
          granted: true,
          balance: result.product.quantity,
          note: 'remise en stock',
        });
      }
      setRaces((r) => {
        const { [product.id]: _cleared, ...rest } = r;
        return rest;
      });
      await reload();
    } finally {
      setFlag(product.id, 'release', false);
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
          productName: product.name,
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
        [product.id]: { tone: 'out', sigil: '!', text: "Le serveur n'a pas répondu. Réessaie." },
      }));
    } finally {
      setFlag(product.id, 'race', false);
    }
  };

  return {
    products,
    quantities,
    notes,
    races,
    busy,
    movements,
    offline,
    setQuantity,
    run,
    runRace,
    restock,
    reload,
  };
}

export type Stock = ReturnType<typeof useStock>;
