import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';

export function ShareCard({ url }: { url: string }) {
  const [qr, setQr] = useState<string>();
  const [copied, setCopied] = useState<'idle' | 'copied' | 'manual'>('idle');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 440, color: { dark: '#111111', light: '#ffffff' } })
      .then((data) => !cancelled && setQr(data))
      .catch(() => !cancelled && setQr(undefined));
    return () => {
      cancelled = true;
    };
  }, [url]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied('copied');
    } catch {
      // Clipboard API needs a secure context; fall back to selecting the text.
      inputRef.current?.select();
      setCopied(document.execCommand?.('copy') ? 'copied' : 'manual');
    }
    setTimeout(() => setCopied('idle'), 2500);
  };

  return (
    <section className="card glass share-card" aria-labelledby="share-heading">
      <h2 id="share-heading">Share this link</h2>
      <p className="muted small-text">
        Anyone with this link can ask for the files. You approve each person before anything is sent.
      </p>
      <div className="link-row">
        <label htmlFor="share-url" className="visually-hidden">
          Sharing link
        </label>
        <input id="share-url" ref={inputRef} className="link-input mono" value={url} readOnly onFocus={(e) => e.target.select()} />
        <button type="button" className="button primary" onClick={copy}>
          {copied === 'copied' ? 'Copied' : 'Copy link'}
        </button>
      </div>
      <p className="visually-hidden" aria-live="polite">
        {copied === 'copied' ? 'Link copied to clipboard' : copied === 'manual' ? 'Press Control+C or Command+C to copy the selected link' : ''}
      </p>
      {copied === 'manual' && <p className="small-text">Link selected — press Ctrl+C / ⌘C to copy.</p>}
      <div className="qr">
        {qr ? <img src={qr} alt="QR code for the sharing link" width={220} height={220} /> : <div className="qr-placeholder" />}
        <p className="muted small-text">Scan with a phone camera to open the link.</p>
      </div>
    </section>
  );
}
