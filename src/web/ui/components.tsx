import { useEffect, useId, useState } from 'react';
import { percent } from '../lib/format';

export function Header() {
  return (
    <header className="site-header">
      <a className="brand" href="/" aria-label="DirectShare home">
        <Logo />
        <span>DirectShare</span>
      </a>
      <a className="parent-link" href="https://razorlabs.dev/" title="More projects on razorlabs.dev">
        <img src="/razorlabs-mark.png" alt="" width={22} height={22} />
        <span>A RazorLabs project</span>
      </a>
    </header>
  );
}

export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <circle cx="9" cy="16" r="4" fill="var(--logo-ink)" />
      <circle cx="23" cy="16" r="4" fill="var(--logo-ink)" />
      <path d="M13 16h6" stroke="var(--logo-ink)" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'muted';

const ICONS: Record<Tone, string> = {
  neutral: '•',
  info: '↻',
  success: '✓',
  warning: '!',
  danger: '✕',
  muted: '–',
};

/** Status pill. Uses text and a glyph, never color alone. */
export function StatusBadge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={`badge badge-${tone}`}>
      <span className="badge-icon" aria-hidden="true">
        {ICONS[tone]}
      </span>
      {children}
    </span>
  );
}

export function ProgressBar({
  value,
  max,
  label,
  tone = 'info',
  size = 'md',
}: {
  value: number;
  max: number;
  label: string;
  tone?: 'info' | 'success' | 'warning' | 'danger' | 'muted';
  size?: 'sm' | 'md';
}) {
  const pct = percent(value, max);
  return (
    <div
      className={`progress progress-${size} progress-${tone}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-valuetext={`${Math.floor(pct)}%`}
    >
      <div className="progress-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Notice({
  tone,
  title,
  children,
  onDismiss,
}: {
  tone: 'info' | 'warning' | 'danger' | 'success';
  title?: string;
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <div className="notice-body">
        {title && <strong className="notice-title">{title}</strong>}
        <div>{children}</div>
      </div>
      {onDismiss && (
        <button type="button" className="icon-button" onClick={onDismiss} aria-label="Dismiss message">
          ✕
        </button>
      )}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return <span className="spinner" role="img" aria-label={label} />;
}

/** Live countdown text for room expiry. */
export function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const minutes = Math.max(0, Math.round((until - now) / 60_000));
  if (minutes >= 120) return <>{Math.round(minutes / 60)} hours</>;
  if (minutes >= 60) return <>1 hour {minutes - 60 > 0 ? `${minutes - 60} min` : ''}</>;
  return <>{minutes} min</>;
}

export function KeepOpenNotice({ role }: { role: 'sender' | 'receiver' }) {
  return (
    <Notice tone="warning" title="Keep this tab open">
      {role === 'sender'
        ? 'Files are sent straight from this tab. Closing, reloading or putting this device to sleep stops every transfer. Receivers also need to keep their tab open until they finish.'
        : 'Files come straight from the sender’s browser. Both of you need to keep your tabs open, and this device awake, until the transfer finishes.'}
    </Notice>
  );
}

export function useLabelId(prefix: string): string {
  return `${prefix}-${useId().replace(/:/g, '')}`;
}
