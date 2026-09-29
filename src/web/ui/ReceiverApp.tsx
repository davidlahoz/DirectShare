import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ClientConfig } from '../../shared/config';
import { MAX_DISPLAY_NAME_LENGTH } from '../../shared/sanitize';
import { formatBytes, formatDuration, formatSpeed, plural } from '../lib/format';
import { type ReceiverPhase, ReceiverSession, type ReceiverSnapshot } from '../session/ReceiverSession';
import { KeepOpenNotice, Notice, ProgressBar, Spinner, StatusBadge, type Tone } from './components';
import { Backdrop } from './Backdrop';
import BlurText from './reactbits/BlurText';
import ClickSpark from './reactbits/ClickSpark';
import ShinyText from './reactbits/ShinyText';
import SpotlightCard from './reactbits/SpotlightCard';
import StarBorder from './reactbits/StarBorder';
import { FileGlyph } from './SenderApp';

const PHASE: Record<ReceiverPhase, { label: string; tone: Tone }> = {
  join: { label: 'Waiting', tone: 'neutral' },
  connecting: { label: 'Connecting', tone: 'info' },
  'awaiting-approval': { label: 'Awaiting approval', tone: 'warning' },
  queued: { label: 'Queued', tone: 'neutral' },
  'connecting-peer': { label: 'Connecting', tone: 'info' },
  'awaiting-acceptance': { label: 'Awaiting acceptance', tone: 'info' },
  transferring: { label: 'Transferring', tone: 'info' },
  completed: { label: 'Completed', tone: 'success' },
  'save-unconfirmed': { label: 'Save unconfirmed', tone: 'warning' },
  rejected: { label: 'Rejected', tone: 'muted' },
  denied: { label: 'Rejected', tone: 'muted' },
  canceled: { label: 'Canceled', tone: 'muted' },
  failed: { label: 'Failed', tone: 'danger' },
  unavailable: { label: 'Unavailable', tone: 'danger' },
};

export function ReceiverApp({ roomId, config }: { roomId: string; config: ClientConfig }) {
  const [session] = useState(() => new ReceiverSession(roomId, config));
  const snap = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (session.hasActiveWork) event.preventDefault();
    };
    const onPageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) session.leave();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [session]);

  const phase = PHASE[snap.phase];
  const waitingForSender = !snap.senderOnline && ['awaiting-approval', 'queued'].includes(snap.phase);

  const calm = snap.phase === 'transferring' || snap.phase === 'connecting-peer';

  return (
    <div className="receiver-layout">
      <Backdrop calm={calm} />
      <section className="hero compact-hero">
        <p className="eyebrow">
          <span className="eyebrow-dot" aria-hidden="true" />
          <ShinyText text="Direct from the sender’s browser" speed={4} />
        </p>
        <BlurText as="h1" text="Receive files" className="hero-title" />
      </section>
      <section className="card glass" aria-labelledby="receive-heading">
        <div className="section-head">
          <h2 id="receive-heading">Your transfer</h2>
          <StatusBadge tone={waitingForSender ? 'warning' : phase.tone}>{waitingForSender ? 'Waiting for sender' : phase.label}</StatusBadge>
        </div>
        {snap.label && (
          <p className="muted small-text">
            The sender sees you as <strong>{snap.displayName ?? snap.label}</strong>.
          </p>
        )}
        <div aria-live="polite">
          <PhaseBody session={session} snap={snap} />
        </div>
      </section>
      <p className="muted small-text center">
        Closing this page ends the connection. It never deletes files that were already saved on your device.
      </p>
    </div>
  );
}

function PhaseBody({ session, snap }: { session: ReceiverSession; snap: ReceiverSnapshot }) {
  switch (snap.phase) {
    case 'join':
      return <JoinForm onJoin={(name) => session.join(name)} />;
    case 'connecting':
      return <Waiting text="Connecting to the sender’s share…" />;
    case 'awaiting-approval':
      return (
        <Waiting
          text={snap.senderOnline ? 'Waiting for the sender to approve you…' : 'The sender’s page is reconnecting. Hang on…'}
          detail="Nothing is transferred until the sender approves you and you accept the files."
        />
      );
    case 'queued':
      return (
        <Waiting
          text={snap.queuePosition ? `Approved — you’re number ${snap.queuePosition} in line.` : 'Approved — getting ready…'}
          detail="The sender sends to a few people at a time. You’ll connect automatically."
        />
      );
    case 'connecting-peer':
      return (
        <>
          <Waiting text="Connecting directly to the sender…" detail="This can take a few seconds." />
          <div className="actions-row">
            <button type="button" className="button ghost" onClick={() => session.cancel()}>
              Cancel
            </button>
          </div>
        </>
      );
    case 'awaiting-acceptance':
      return <Review session={session} snap={snap} />;
    case 'transferring':
      return <Transfer session={session} snap={snap} />;
    case 'completed':
      return (
        <div className="stack-sm">
          <Notice tone="success" title="All files received">
            Every file was received, checked and saved to <strong>{snap.destination}</strong>. You can close this page.
          </Notice>
          <FileProgressList snap={snap} />
        </div>
      );
    case 'save-unconfirmed':
      return (
        <div className="stack-sm">
          <Notice tone="warning" title="Delivered to your browser — save unconfirmed">
            All files were received and handed to your browser’s downloads. Check your Downloads folder: DirectSend can’t
            confirm your browser saved them. If a file is missing, ask the sender to share again.
          </Notice>
          <FileProgressList snap={snap} />
        </div>
      );
    default:
      return <Ended session={session} snap={snap} />;
  }
}

function JoinForm({ onJoin }: { onJoin(name?: string): void }) {
  const [name, setName] = useState('');
  return (
    <form
      className="stack-sm"
      onSubmit={(e) => {
        e.preventDefault();
        onJoin(name);
      }}
    >
      <p>Someone wants to send you files directly from their browser.</p>
      <div className="field">
        <label htmlFor="display-name">Your name (optional)</label>
        <input
          id="display-name"
          type="text"
          autoComplete="nickname"
          maxLength={MAX_DISPLAY_NAME_LENGTH}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Alex’s laptop"
          aria-describedby="display-name-hint"
        />
        <p id="display-name-hint" className="muted small-text">
          Helps the sender recognize you. Leave empty to appear as “Receiver 1”, “Receiver 2”…
        </p>
      </div>
      <KeepOpenNotice role="receiver" />
      <ClickSpark>
        <StarBorder className="cta-border">
          <button type="submit" className="button primary large cta">
            Connect to sender
          </button>
        </StarBorder>
      </ClickSpark>
    </form>
  );
}

function Waiting({ text, detail }: { text: string; detail?: string }) {
  return (
    <div className="waiting">
      <Spinner label="In progress" />
      <div>
        <p>
          <ShinyText text={text} speed={2.5} />
        </p>
        {detail && <p className="muted small-text">{detail}</p>}
      </div>
    </div>
  );
}

function Review({ session, snap }: { session: ReceiverSession; snap: ReceiverSnapshot }) {
  const offer = snap.offer!;
  const caps = snap.capabilities;
  const single = offer.files.length === 1;
  const streaming = caps.directory || (single && caps.saveFile);
  const memoryOk = offer.totalBytes <= snap.memoryLimit;
  const retryNote = offer.shareFileCount > offer.files.length;

  return (
    <div className="stack-sm">
      <p>
        The sender is offering <strong>{plural(offer.files.length, 'file')}</strong> ·{' '}
        <strong className="mono">{formatBytes(offer.totalBytes)}</strong>
        {retryNote && <span className="muted"> (remaining from {plural(offer.shareFileCount, 'file')} shared)</span>}
      </p>
      <ul className="file-list" aria-label="Offered files">
        {offer.files.map((f) => (
          <li key={f.fileId} className="file-row">
            <FileGlyph />
            <span className="file-name" title={f.safeName}>
              {f.safeName}
            </span>
            <span className="file-size mono">{formatBytes(f.size)}</span>
          </li>
        ))}
      </ul>
      <p className="muted small-text">
        Only accept files from people you trust. File names come from the sender and are shown as received (made safe for
        saving).
      </p>

      <KeepOpenNotice role="receiver" />

      <fieldset className="destinations">
        <legend>Choose where to save</legend>
        {snap.pickerError && <Notice tone="danger">{snap.pickerError}</Notice>}

        {caps.directory && (
          <SpotlightCard className="destination recommended">
            <div>
              <strong>Save to a folder</strong> <StatusBadge tone="success">Recommended</StatusBadge>
              <p className="muted small-text">
                Streams each file straight to disk, so large files don’t fill up memory. Your browser will ask for permission
                to save in the folder you pick. Existing files are never overwritten.
              </p>
            </div>
            <ClickSpark className="inline">
              <button type="button" className="button primary" onClick={() => void session.chooseFolderAndAccept()}>
                Choose folder and accept
              </button>
            </ClickSpark>
          </SpotlightCard>
        )}

        {single && caps.saveFile && (
          <SpotlightCard className="destination">
            <div>
              <strong>Save as…</strong>
              <p className="muted small-text">Pick the exact file name and location. Also streams to disk.</p>
            </div>
            <button type="button" className={`button ${caps.directory ? 'secondary' : 'primary'}`} onClick={() => void session.chooseFileAndAccept()}>
              Choose location and accept
            </button>
          </SpotlightCard>
        )}

        {memoryOk ? (
          <SpotlightCard className="destination">
            <div>
              <strong>Download through the browser</strong>
              <p className="muted small-text">
                {streaming ? 'Alternative for smaller transfers: each' : 'This browser can’t stream files to disk, so each'} file is held in memory until complete, then passed to your browser’s downloads (limit{' '}
                {formatBytes(snap.memoryLimit)}). DirectSend can’t confirm your browser saved it.
              </p>
            </div>
            <button type="button" className={`button ${streaming ? 'secondary' : 'primary'}`} onClick={() => session.acceptBrowserDownload()}>
              Accept and download
            </button>
          </SpotlightCard>
        ) : (
          !streaming && (
            <Notice tone="danger" title="Too large for this browser">
              This browser can’t save files directly to disk, and this transfer ({formatBytes(offer.totalBytes)}) is over the{' '}
              {formatBytes(snap.memoryLimit)} in-memory limit. Open the link in a desktop browser that supports saving to a
              folder (for example Chrome or Edge){caps.secureContext ? '' : ' over HTTPS'}, or ask the sender for smaller
              files.
            </Notice>
          )
        )}
        {!caps.secureContext && (
          <p className="muted small-text">Saving straight to disk needs a secure (HTTPS) connection to this site.</p>
        )}
      </fieldset>

      <div className="actions-row">
        <button type="button" className="button ghost" onClick={() => session.reject(!streaming && !memoryOk ? 'too-large' : 'declined')}>
          {!streaming && !memoryOk ? 'Tell the sender and close' : 'Decline'}
        </button>
      </div>
    </div>
  );
}

function Transfer({ session, snap }: { session: ReceiverSession; snap: ReceiverSnapshot }) {
  return (
    <div className="stack-sm">
      <div className="progress-meta">
        <span className="mono">
          {formatBytes(snap.doneBytes)} of {formatBytes(snap.totalBytes)}
        </span>
        <span className="mono muted">
          {formatSpeed(snap.bytesPerSecond)} · {formatDuration(snap.etaSeconds)} left
        </span>
      </div>
      <ProgressBar value={snap.doneBytes} max={snap.totalBytes} label="Overall progress" />
      <p className="muted small-text">
        Saving to <strong>{snap.destination}</strong>
        {snap.path === 'local-network' ? ' · direct connection on your local network' : snap.path === 'internet' ? ' · direct connection over the internet' : ''}
      </p>
      <FileProgressList snap={snap} />
      <KeepOpenNotice role="receiver" />
      <div className="actions-row">
        <button type="button" className="button ghost" onClick={() => session.cancel()}>
          Cancel transfer
        </button>
      </div>
    </div>
  );
}

function FileProgressList({ snap }: { snap: ReceiverSnapshot }) {
  return (
    <ul className="file-progress-list" aria-label="Per-file progress">
      {snap.files.map((f) => (
        <li key={f.fileId}>
          <div className="progress-meta">
            <span className="file-name" title={f.name}>
              {f.savedName && f.savedName !== f.name ? `${f.name} → ${f.savedName}` : f.name}
            </span>
            <span className="mono muted">
              {f.state === 'saved'
                ? 'Saved ✓'
                : f.state === 'delivered'
                  ? 'In browser downloads'
                  : f.state === 'pending'
                    ? 'Waiting'
                    : `${formatBytes(f.bytes)} / ${formatBytes(f.size)}`}
            </span>
          </div>
          <ProgressBar size="sm" value={f.bytes} max={f.size} label={f.name} tone={f.state === 'saved' ? 'success' : f.state === 'delivered' ? 'warning' : 'info'} />
        </li>
      ))}
    </ul>
  );
}

function Ended({ session, snap }: { session: ReceiverSession; snap: ReceiverSnapshot }) {
  const saved = snap.files.filter((f) => f.state === 'saved' || f.state === 'delivered');
  const tone = snap.phase === 'failed' || snap.phase === 'unavailable' ? 'danger' : 'info';
  return (
    <div className="stack-sm">
      <Notice tone={tone} title={snap.error?.title ?? 'Transfer ended'}>
        {snap.error?.message ?? 'This transfer has ended.'}
      </Notice>
      {saved.length > 0 && (
        <>
          <p className="small-text">
            {plural(saved.length, 'file')} finished before this happened and {saved.length === 1 ? 'is' : 'are'} kept:
          </p>
          <FileProgressList snap={{ ...snap, files: saved }} />
        </>
      )}
      {snap.canRetry && (
        <div className="actions-row">
          <button type="button" className="button primary" onClick={() => session.retry()}>
            Try again
          </button>
          <span className="muted small-text">Unfinished files restart from the beginning.</span>
        </div>
      )}
      {!snap.canRetry && snap.phase !== 'unavailable' && snap.phase !== 'denied' && (
        <p className="muted small-text">To try again, ask the sender for a new link or to retry from their page.</p>
      )}
    </div>
  );
}
