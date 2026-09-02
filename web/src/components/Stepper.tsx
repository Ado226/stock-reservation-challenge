interface StepperProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange(value: number): void;
}

/**
 * Sélecteur de quantité borné. Remplace le champ numérique libre : on ne peut
 * plus saisir 0, -3 ou « deux ». La validation serveur reste la garantie, mais
 * l'interface n'a pas à laisser composer une requête qu'elle sait invalide.
 */
export function Stepper({ id, label, value, min, max, disabled, onChange }: StepperProps) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));

  return (
    <div className="stepper">
      <button
        type="button"
        aria-label={`Retirer une unité (${label})`}
        disabled={disabled || value <= min}
        onClick={() => onChange(clamp(value - 1))}
      >
        −
      </button>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(clamp(Math.trunc(next)));
        }}
      />
      <button
        type="button"
        aria-label={`Ajouter une unité (${label})`}
        disabled={disabled || value >= max}
        onClick={() => onChange(clamp(value + 1))}
      >
        +
      </button>
    </div>
  );
}
