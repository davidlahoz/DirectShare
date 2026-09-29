import { formatBytes, formatDuration, formatSpeed, plural } from '../lib/format';
import type { ReceiverView } from '../session/SenderSession';
import type { ReceiverStatus } from '../session/scheduler';
import { ProgressBar, StatusBadge, type Tone } from './components';

export const SENDER_STATUS: Record<ReceiverStatus, { label: string; tone: Tone }> = {
  'awaiting-approval': { label: 'Awaiting approval', tone: 'warning' },
  queued: { label: 'Queued', tone: 'neutral' },
  connecting: { label: 'Connecting', tone: 'info' },
  'awaiting-acceptance': { label: 'Awaiting acceptance', tone: 'info' },
  transferring: { label: 'Transferring', tone: 'info' },
  completed: { label: 'Completed', tone: 'success' },
  'save-unconfirmed': { label: 'Save unconfirmed', tone: 'warning' },
  rejected: { label: 'Rejected', tone: 'muted' },
  denied: { label: 'Rejected', tone: 'muted' },
  canceled: { label: 'Canceled', tone: 'muted' },
  failed: { label: 'Failed', tone: 'danger' },
  left: { label: 'Left', tone: 'muted' },
};

interface Props {
  receivers: ReceiverView[];
  sharing: boolean;
  onApprove(id: string): void;
  onDeny(id: string): void;
  onCancel(id: string): void;
  onRetry(id: string): void;
}

export function ReceiverList({ receivers, sharing, ...actions }: Props) {
  const waitingApproval = receivers.filter((r) => r.status === 'awaiting-approval').length;
  return (
    <section className="card" aria-labelledby="receivers-heading">
      <div className="section-head">
        <h2 id="receivers-heading">Receivers</h2>
        {waitingApproval > 0 && <StatusBadge tone="warning">{plural(waitingApproval, 'request')} waiting</StatusBadge>}
      </div>
      {receivers.length === 0 ? (
        <div className="empty">
          <StatusBadge tone="neutral">Waiting</StatusBadge>
          <p className="muted">{sharing ? 'Waiting for someone to open the link…' : 'Nobody joined this share.'}</p>
        </div>
      ) : (
        <ul className="receiver-list" aria-live="polite">
          {sortForAttention(receivers).map((r) => (
            <ReceiverCard key={r.sessionId} receiver={r} sharing={sharing} {...actions} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ReceiverCard({
  receiver: r,
  sharing,
  onApprove,
  onDeny,
  onCancel,
  onRetry,
}: { receiver: ReceiverView; sharing: boolean } & Omit<Props, 'receivers' | 'sharing'>) {
  const status = SENDER_STATUS[r.status];
  const name = r.displayName ?? r.label;
  const showProgress = r.files.length > 0 && ['awaiting-acceptance', 'transferring', 'completed', 'save-unconfirmed', 'failed', 'canceled'].includes(r.status);
  const cancellable = ['queued', 'connecting', 'awaiting-acceptance', 'transferring'].includes(r.status);
  const retryable = sharing && r.online && ['failed', 'canceled', 'rejected'].includes(r.status);

  return (
    <li className={`receiver receiver-${r.status}`}>
      <div className="receiver-head">
        <div className="receiver-id">
          <span className="avatar" aria-hidden="true">
            {Array.from(name)[0]?.toUpperCase() ?? '?'}
          </span>
          <div>
            <p className="receiver-name">
              {name}
              {r.displayName && <span className="muted small-text"> · {r.label}</span>}
            </p>
            <p className="muted small-text">
              {!r.online && !['completed', 'save-unconfirmed', 'left', 'denied'].includes(r.status) ? 'Offline · ' : ''}
              {r.attempt > 1 ? `Attempt ${r.attempt} · ` : ''}
              {r.path === 'local-network' ? 'Direct · local network' : r.path === 'internet' ? 'Direct · over the internet' : ''}
            </p>
          </div>
        </div>
        <StatusBadge tone={status.tone}>
          {status.label}
          {r.status === 'queued' && r.queuePosition ? ` · #${r.queuePosition}` : ''}
        </StatusBadge>
      </div>

      {r.status === 'awaiting-approval' && (
        <div className="approval">
          <p className="small-text">
            Only approve people you expect. Names are chosen by the receiver and aren’t verified.
          </p>
          <div className="actions-row">
            <button type="button" className="button primary small" onClick={() => onApprove(r.sessionId)}>
              Approve {name}
            </button>
            <button type="button" className="button ghost small" onClick={() => onDeny(r.sessionId)}>
              Reject
            </button>
          </div>
        </div>
      )}

      {r.status === 'queued' && (
        <p className="muted small-text">Approved. Starts automatically when a transfer slot frees up.</p>
      )}
      {r.status === 'connecting' && <p className="muted small-text">Setting up a direct connection…</p>}
      {r.status === 'awaiting-acceptance' && <p className="muted small-text">Waiting for the receiver to choose where to save and accept.</p>}
      {r.alreadyDelivered > 0 && ['awaiting-acceptance', 'transferring'].includes(r.status) && (
        <p className="muted small-text">Retrying: {plural(r.alreadyDelivered, 'file')} already delivered won’t be sent again.</p>
      )}
      {r.status === 'save-unconfirmed' && (
        <p className="small-text">Delivered to the receiver’s browser — save unconfirmed. Their browser handled the download, so the app can’t confirm it was saved.</p>
      )}
      {r.message && <p className={`small-text ${r.status === 'failed' ? 'danger-text' : 'muted'}`}>{r.message}</p>}

      {showProgress && (
        <div className="receiver-progress">
          <div className="progress-meta">
            <span className="mono">
              {formatBytes(r.doneBytes)} of {formatBytes(r.totalBytes)}
            </span>
            {r.status === 'transferring' && (
              <span className="mono muted">
                {formatSpeed(r.bytesPerSecond)} · {formatDuration(r.etaSeconds)} left
              </span>
            )}
          </div>
          <ProgressBar
            value={r.doneBytes}
            max={r.totalBytes}
            label={`Overall progress for ${name}`}
            tone={r.status === 'failed' ? 'danger' : r.status === 'completed' ? 'success' : r.status === 'transferring' ? 'info' : 'muted'}
          />
          <details className="file-progress" open={r.files.length <= 3 && r.status === 'transferring'}>
            <summary>Per-file progress ({plural(r.files.length, 'file')})</summary>
            <ul>
              {r.files.map((f) => (
                <li key={f.fileId}>
                  <div className="progress-meta">
                    <span className="file-name" title={f.name}>
                      {f.name}
                    </span>
                    <span className="mono muted">{fileStateText(f.state, f.bytes, f.size)}</span>
                  </div>
                  <ProgressBar
                    size="sm"
                    value={f.bytes}
                    max={f.size}
                    label={`${f.name} for ${name}`}
                    tone={f.state === 'confirmed' ? 'success' : f.state === 'unconfirmed' || f.state === 'save-unconfirmed' ? 'warning' : 'info'}
                  />
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {(cancellable || retryable) && (
        <div className="actions-row">
          {cancellable && (
            <button type="button" className="button ghost small" onClick={() => onCancel(r.sessionId)}>
              Cancel transfer
            </button>
          )}
          {retryable && (
            <button type="button" className="button secondary small" onClick={() => onRetry(r.sessionId)}>
              Retry
            </button>
          )}
        </div>
      )}
      {retryable && <p className="muted small-text">Retries restart interrupted files from the beginning.</p>}
    </li>
  );
}

/** Approval requests first, then active transfers, then everything else; join order within each group. */
function sortForAttention(receivers: ReceiverView[]): ReceiverView[] {
  const rank = (r: ReceiverView) =>
    r.status === 'awaiting-approval' ? 0 : ['connecting', 'awaiting-acceptance', 'transferring', 'queued'].includes(r.status) ? 1 : 2;
  return receivers.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map(({ r }) => r);
}

function fileStateText(state: ReceiverView['files'][number]['state'], bytes: number, size: number): string {
  switch (state) {
    case 'confirmed':
      return 'Saved ✓';
    case 'save-unconfirmed':
      return 'In browser downloads';
    case 'unconfirmed':
      return 'Sent, unconfirmed';
    case 'pending':
      return 'Waiting';
    default:
      return `${formatBytes(bytes)} / ${formatBytes(size)}`;
  }
}
