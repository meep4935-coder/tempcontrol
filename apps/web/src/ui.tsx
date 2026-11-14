/** Small building blocks shared by every screen. */

import { useEffect, useState, type ReactNode } from 'react';

const PATHS = {
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z',
  bars: 'M5 20v-6m7 6V5m7 15v-9',
  chat: 'M5 5h14v10H10l-5 4z',
  gear: 'M4 7h9m5 0h2M4 17h2m5 0h9M15.5 4.5v5M8.5 14.5v5',
  chevron: 'M9 5l7 7-7 7',
  back: 'M15 5l-7 7 7 7',
  close: 'M6 6l12 12M18 6L6 18',
  sun: 'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6l1.4 1.4m10 10l1.4 1.4m0-12.8L17 7M7 17l-1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  snow: 'M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9M9.5 4.5L12 7l2.5-2.5M9.5 19.5L12 17l2.5 2.5',
  play: 'M8 5l11 7-11 7z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  mic: 'M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm-6-3a6 6 0 0 0 12 0M12 18v3',
  send: 'M5 12h13m-5-6l6 6-6 6',
  spark: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
} as const;

export function Icon({ name, size = 22 }: { name: keyof typeof PATHS; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[name]} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A panel that slides up from the bottom of the screen. */
export function Sheet({ title, onClose, closeLabel, children }: { title: string; onClose: () => void; closeLabel: string; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>{title}</h2>
          <button className="round" onClick={onClose} aria-label={closeLabel}>
            <Icon name="close" size={18} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

/** A settings-style list: rows inside one rounded group. */
export function Group({ title, note, children }: { title?: string; note?: string; children: ReactNode }) {
  return (
    <section className="group">
      {title && <h2 className="group-title">{title}</h2>}
      <div className="group-body">{children}</div>
      {note && <p className="group-note">{note}</p>}
    </section>
  );
}

/** One row: a label on the left, a value or control on the right. */
export function Row({ label, hint, children, onClick, wrap }: { label: string; hint?: string; children?: ReactNode; onClick?: () => void; /** The row holds one control: make the whole row its label. */ wrap?: boolean }) {
  const body = (
    <>
      <span className="row-text">
        <span className="row-label">{label}</span>
        {hint && <span className="row-hint">{hint}</span>}
      </span>
      <span className="row-value">
        {children}
        {onClick && <Icon name="chevron" size={16} />}
      </span>
    </>
  );
  return onClick ? (
    <button className="row tap" onClick={onClick}>
      {body}
    </button>
  ) : wrap ? (
    <label className="row">{body}</label>
  ) : (
    <div className="row">{body}</div>
  );
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <span className="switch">
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span aria-hidden="true" />
    </span>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <span className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={o.id === value} disabled={disabled} onClick={() => o.id !== value && onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </span>
  );
}

/** A text-like input that saves when the user leaves it or presses Enter. */
export function Input({ value, type = 'text', onSave, disabled, label }: { value: string; type?: string; onSave: (v: string) => void; disabled?: boolean; label: string }) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  return (
    <input
      className="inline"
      type={type}
      aria-label={label}
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && draft !== '' && onSave(draft)}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  );
}

/** Minus, value, plus. */
export function Stepper({ value, shown, onChange, lower, raise, disabled }: { value: number; shown: string; onChange: (v: number) => void; lower: string; raise: string; disabled?: boolean }) {
  return (
    <span className="stepper">
      <button type="button" className="round" aria-label={lower} disabled={disabled} onClick={() => onChange(value - 0.5)}>
        −
      </button>
      <output>{shown}</output>
      <button type="button" className="round" aria-label={raise} disabled={disabled} onClick={() => onChange(value + 0.5)}>
        +
      </button>
    </span>
  );
}
