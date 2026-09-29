/**
 * Browser WebSocket client for the signaling server, with automatic
 * reconnection. The owning session decides what to send on (re)connect,
 * e.g. resuming a room with its stored credentials.
 */
import {
  type ClientMessage,
  parseServerMessage,
  SIGNALING_PATH,
  SIGNALING_SUBPROTOCOL,
  type ServerMessage,
} from '../../shared/signaling';

export type SignalingStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SignalingClientOptions {
  url?: string;
  onMessage(message: ServerMessage): void;
  onStatus(status: SignalingStatus): void;
  /** Called after every successful (re)connection. */
  onOpen(): void;
  /** Give up reconnecting after this long (ms). */
  maxReconnectMs?: number;
}

const KEEPALIVE_MS = 25_000;

export function defaultSignalingUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}${SIGNALING_PATH}`;
}

export class SignalingClient {
  private ws: WebSocket | undefined;
  private closedByUser = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  private disconnectedSince: number | undefined;
  private status: SignalingStatus = 'connecting';

  constructor(private readonly opts: SignalingClientOptions) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  send(message: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  /** Closes for good; no further reconnection attempts. */
  close(): void {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.keepaliveTimer);
    const ws = this.ws;
    this.ws = undefined;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close(1000, 'closed');
    this.setStatus('closed');
  }

  private open(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url ?? defaultSignalingUrl(), SIGNALING_SUBPROTOCOL);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.disconnectedSince = undefined;
      this.setStatus('open');
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = setInterval(() => this.send({ type: 'ping' }), KEEPALIVE_MS);
      this.opts.onOpen();
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws || typeof event.data !== 'string') return;
      const parsed = parseServerMessage(event.data);
      if (parsed.ok) this.opts.onMessage(parsed.message);
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      clearInterval(this.keepaliveTimer);
      // 4001: replaced by a newer connection; 4002: room ended. Both are final.
      if (this.closedByUser || event.code === 4001 || event.code === 4002 || event.code === 1008) {
        this.setStatus('closed');
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    this.disconnectedSince ??= Date.now();
    if (Date.now() - this.disconnectedSince > (this.opts.maxReconnectMs ?? 5 * 60_000)) {
      this.setStatus('closed');
      return;
    }
    this.setStatus('reconnecting');
    const delay = Math.min(10_000, 500 * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private setStatus(status: SignalingStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatus(status);
  }
}
