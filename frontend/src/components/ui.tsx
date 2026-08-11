import type { ReactNode } from 'react';

type Tone = 'default' | 'success' | 'warn' | 'danger' | 'flare';

const toneClasses: Record<Tone, string> = {
  default: 'bg-ink-700 text-ink-200 border-ink-600',
  success: 'bg-signal-500/10 text-signal-400 border-signal-500/30',
  warn: 'bg-warn-500/10 text-warn-500 border-warn-500/30',
  danger: 'bg-danger-500/10 text-danger-500 border-danger-500/30',
  flare: 'bg-flare-500/10 text-flare-300 border-flare-500/30',
};

export function Badge({
  tone = 'default',
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${toneClasses[tone]}`}
    >
      {children}
    </span>
  );
}

export function Card({
  title,
  subtitle,
  action,
  children,
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-ink-700 bg-ink-900 p-5">
      {(title || action) && (
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            {title && (
              <h2 className="text-sm font-semibold text-ink-50">{title}</h2>
            )}
            {subtitle && (
              <p className="mt-0.5 text-xs text-ink-400">{subtitle}</p>
            )}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Button({
  variant = 'primary',
  disabled,
  onClick,
  children,
  type = 'button',
}: {
  variant?: 'primary' | 'ghost';
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
  type?: 'button' | 'submit';
}) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';
  const variants = {
    primary: 'bg-flare-500 text-white hover:bg-flare-400',
    ghost: 'border border-ink-600 text-ink-200 hover:bg-ink-800',
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${variants[variant]}`}
    >
      {children}
    </button>
  );
}
