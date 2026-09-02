import type { MutationResult, Operation } from './api.js';

export interface Movement {
  id: string;
  at: Date;
  productId: number;
  productName: string;
  operation: Operation;
  quantity: number;
  granted: boolean;
  /** Solde après le mouvement. Absent si l'opération a été refusée. */
  balance?: number;
  /** Ce qui s'est passé : motif du refus, rejeu, ou canal du test de concurrence. */
  note?: string;
}

export interface Note {
  tone: 'in' | 'out' | 'probe';
  sigil: string;
  text: string;
}

export interface Race {
  a: MutationResult;
  b: MutationResult;
  /** Stock avant la course : c'est lui qui rend le test décisif ou non. */
  stockBefore: number;
}

export interface Busy {
  reserve: boolean;
  release: boolean;
  race: boolean;
}

export const IDLE: Busy = { reserve: false, release: false, race: false };

export const ref = (id: number) => String(id).padStart(3, '0');
