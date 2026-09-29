import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ClientConfig } from '../../shared/config';
import { summarizeHistory } from '../history/downloadHistory';
import { formatBytes, plural } from '../lib/format';
import { SenderSession, type SenderSnapshot } from '../session/SenderSession';
import { Countdown, KeepOpenNotice, Notice, Spinner } from './components';
import { HistoryPanel } from './HistoryPanel';
import { ReceiverList } from './ReceiverList';
import { ShareCard } from './ShareCard';

export function SenderApp({ config }: { config: ClientConfig }) {
  const [session] = useState(() => new SenderSession(config));
  const snap = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (session.hasActiveWork) event.preventDefault();
    };
    // Closing the tab ends the room right away instead of waiting for the reconnect grace period.
    const onPageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) session.stopSharing('page-closed');
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [session]);

  if (snap.phase === 'select' || snap.phase === 'creating') {
    return <SelectFiles session={session} snap={snap} config={config} />;
  }
  return <Sharing session={session} snap={snap} />;
}

// ---------------------------------------------------------------------------

function SelectFiles({ session, snap, config }: { session: SenderSession; snap: SenderSnapshot; config: ClientConfig }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const creating = snap.phase === 'creating';

  const addFromList = (list: FileList | null) => {
    if (list && list.length > 0) session.addFiles(Array.from(list));
  };

  return (
    <div className="stack">
      <section className="hero">
        <h1>Send files directly to another browser</h1>
        <p className="lead">
          Pick files, share a link, and approve who gets them. Files go straight from this device to theirs — nothing is
          uploaded to a server.
        </p>
      </section>

      {snap.notice && (
        <Notice tone={snap.notice.tone === 'error' ? 'danger' : 'info'} onDismiss={() => session.dismissNotice()}>
          {snap.notice.text}
        </Notice>
      )}

      <section aria-labelledby="choose-files" className="card">
        <h2 id="choose-files" className="visually-hidden">
          Choose files
        </h2>
        <div
          className={`dropzone${dragging ? ' dragging' : ''}`}
          onDragEnter={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            // Folders are not supported: keep only real files (folders show up with size 0 and no type).
            const files = Array.from(e.dataTransfer.items ?? [])
              .filter((item) => item.kind === 'file' && !(item.webkitGetAsEntry?.()?.isDirectory ?? false))
              .map((item) => item.getAsFile())
              .filter((f): f is File => f !== null);
            if (files.length > 0) session.addFiles(files);
            else addFromList(e.dataTransfer.files);
          }}
        >
          <svg className="drop-icon" viewBox="0 0 48 48" aria-hidden="true">
            <path d="M24 30V10m0 0-8 8m8-8 8 8" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M8 30v6a4 4 0 0 0 4 4h24a4 4 0 0 0 4-4v-6" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
          <p className="drop-title">Drag and drop files here</p>
          <p className="muted">or</p>
          <button type="button" className="button primary" onClick={() => inputRef.current?.click()} disabled={creating}>
            Choose files
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="visually-hidden"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              addFromList(e.target.files);
              e.target.value = '';
            }}
          />
        </div>

        {snap.files.length > 0 && (
          <div className="selection">
            <div className="selection-head">
              <h3>
                {plural(snap.files.length, 'file')} · <span className="mono">{formatBytes(snap.totalBytes)}</span> total
              </h3>
              <button type="button" className="button ghost small" onClick={() => session.clearFiles()} disabled={creating}>
                Remove all
              </button>
            </div>
            <ul className="file-list" aria-label="Selected files">
              {snap.files.map((f) => (
                <li key={f.fileId} className="file-row">
                  <FileGlyph />
                  <span className="file-name" title={f.name}>
                    {f.name}
                  </span>
                  <span className="file-size mono">{formatBytes(f.size)}</span>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => session.removeFile(f.fileId)}
                    disabled={creating}
                    aria-label={`Remove ${f.name}`}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
            <div className="actions">
              <button type="button" className="button primary large" onClick={() => session.startSharing()} disabled={creating}>
                {creating ? (
                  <>
                    <Spinner label="" /> Creating link…
                  </>
                ) : (
                  'Create sharing link'
                )}
              </button>
              <p className="hint">
                The file list is locked once sharing starts. Links last up to {Math.round(config.roomTtlSeconds / 60)} minutes
                and allow up to {plural(config.maxReceiversPerRoom, 'receiver')}.
              </p>
            </div>
          </div>
        )}
      </section>

      <section className="how card subtle" aria-labelledby="how-it-works">
        <h2 id="how-it-works">How it works</h2>
        <ol className="steps">
          <li>
            <strong>Share the link or QR code.</strong> Anyone with the link can ask to receive — treat it like a password.
          </li>
          <li>
            <strong>Approve each receiver.</strong> Nothing is sent until you approve them and they accept.
          </li>
          <li>
            <strong>Keep this tab open.</strong> Each receiver gets their own direct, encrypted connection to this browser.
          </li>
        </ol>
        <p className="muted small-text">
          Very large files work best when the receiver uses a desktop browser that can save straight to disk (such as Chrome
          or Edge). Other browsers can receive smaller transfers (up to {formatBytes(config.memoryFallbackMaxBytes)}). Practical
          limits depend on the browsers, free storage and device memory.
        </p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Sharing({ session, snap }: { session: SenderSession; snap: SenderSnapshot }) {
  const summary = summarizeHistory(
    snap.history,
    snap.files.map((f) => f.fileId),
  );
  const active = snap.phase === 'sharing';
  const pendingApprovals = snap.receivers.filter((r) => r.status === 'awaiting-approval').length;

  return (
    <div className="sharing-layout">
      <aside className="share-column" aria-label="Sharing controls">
        {active && snap.shareUrl ? (
          <ShareCard url={snap.shareUrl} />
        ) : (
          <section className="card">
            <h2>{snap.phase === 'stopped' ? 'Sharing stopped' : 'Link closed'}</h2>
            <p className="muted">
              {snap.phase === 'stopped'
                ? 'The link no longer works and new receivers cannot join.'
                : snap.endedReason}{' '}
              Files already saved on receivers’ devices are not affected.
            </p>
            <p className="muted small-text">History stays on this page until you clear it, reload, or close the tab.</p>
            <div className="actions-row">
              <button type="button" className="button primary" onClick={() => session.reset()}>
                Start a new share
              </button>
            </div>
          </section>
        )}

        {active && (
          <section className="card compact">
            <dl className="facts">
              <div>
                <dt>Status</dt>
                <dd>
                  {snap.signaling === 'open' ? (
                    'Link active'
                  ) : snap.signaling === 'reconnecting' ? (
                    <span className="warn-text">Reconnecting to server…</span>
                  ) : (
                    'Connecting…'
                  )}
                </dd>
              </div>
              {snap.expiresAt && (
                <div>
                  <dt>Link expires in</dt>
                  <dd>
                    <Countdown until={snap.expiresAt} />
                  </dd>
                </div>
              )}
              <div>
                <dt>Simultaneous transfers</dt>
                <dd>Up to {snap.maxConcurrent}; others wait in line</dd>
              </div>
            </dl>
            <button type="button" className="button danger full" onClick={() => session.stopSharing()}>
              Stop sharing
            </button>
          </section>
        )}

        <section className="card compact" aria-labelledby="shared-files">
          <div className="section-head">
            <h2 id="shared-files">Shared files</h2>
            <span className="lock" title="The selection can't be changed after sharing starts">
              Locked
            </span>
          </div>
          <p className="muted small-text">
            {plural(snap.files.length, 'file')} · <span className="mono">{formatBytes(snap.totalBytes)}</span>. To change
            files, stop sharing and start a new share.
          </p>
          <ul className="file-list compact" aria-label="Shared files">
            {snap.files.map((f) => (
              <li key={f.fileId} className="file-row">
                <FileGlyph />
                <span className="file-name" title={f.name}>
                  {f.name}
                </span>
                <span className="file-size mono">{formatBytes(f.size)}</span>
              </li>
            ))}
          </ul>
        </section>
      </aside>

      <div className="main-column">
        {snap.notice && (
          <Notice tone={snap.notice.tone === 'error' ? 'danger' : 'info'} onDismiss={() => session.dismissNotice()}>
            {snap.notice.text}
          </Notice>
        )}
        {snap.phase === 'ended' && snap.endedReason && (
          <Notice tone="warning" title="Link closed">
            {snap.endedReason}
          </Notice>
        )}
        {active && <KeepOpenNotice role="sender" />}
        {active && pendingApprovals > 0 && (
          <Notice tone="info" title={`${plural(pendingApprovals, 'person is', 'people are')} waiting for approval`}>
            <a href="#receivers-heading">Review requests</a> — nothing is sent until you approve.
          </Notice>
        )}

        <HistoryPanel summary={summary} fileCount={snap.files.length} onClear={() => session.clearHistory()} />

        <ReceiverList
          receivers={snap.receivers}
          sharing={active}
          onApprove={(id) => session.approve(id)}
          onDeny={(id) => session.deny(id)}
          onCancel={(id) => session.cancel(id)}
          onRetry={(id) => session.retry(id)}
        />
      </div>
    </div>
  );
}

export function FileGlyph() {
  return (
    <svg className="file-glyph" viewBox="0 0 20 24" aria-hidden="true">
      <path d="M3 1h9l6 6v14a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 1v6h6" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
