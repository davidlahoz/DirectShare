import type { ClientConfig } from '../../shared/config';
import { idSchema } from '../../shared/signaling';
import { ReceiverApp } from './ReceiverApp';
import { SenderApp } from './SenderApp';
import { Header } from './components';

export function App({ config }: { config: ClientConfig }) {
  const isJoin = location.pathname === '/join';
  const roomId = decodeURIComponent(location.hash.replace(/^#/, ''));

  if (isJoin) {
    if (!idSchema.safeParse(roomId).success) {
      return (
        <Shell>
          <section className="card narrow" aria-labelledby="bad-link">
            <h1 id="bad-link">This link looks incomplete</h1>
            <p className="muted">
              Sharing links end with a long code after a <code>#</code>. Ask the sender to copy the link again, or scan
              their QR code.
            </p>
            <a className="button primary" href="/">
              Send files instead
            </a>
          </section>
        </Shell>
      );
    }
    return (
      <Shell>
        <ReceiverApp roomId={roomId} config={config} />
      </Shell>
    );
  }
  return (
    <Shell>
      <SenderApp config={config} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Header />
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <footer className="site-footer">
        <p>
          Files travel directly between browsers over an encrypted WebRTC connection (DTLS). The DirectShare server only
          helps the two devices find each other and never receives file contents.
        </p>
      </footer>
    </>
  );
}
