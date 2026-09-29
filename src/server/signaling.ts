/**
 * WebSocket signaling service: authenticates roles, enforces room rules and
 * relays WebRTC negotiation messages between the sender and one specific
 * receiver. It is transport-agnostic (see `Connection`) so it can be tested
 * without sockets.
 *
 * Isolation rules:
 *  - A receiver can only address the sender; its `to` field is ignored.
 *  - The sender must name a receiver of its own room.
 *  - Relayed payloads are re-validated and each role may only originate
 *    specific signal kinds.
 *  - Negotiation is only relayed for receivers the sender approved.
 */
import {
  type ClientMessage,
  parseClientMessage,
  RECEIVER_SIGNAL_KINDS,
  type RoomClosedReason,
  SENDER_SIGNAL_KINDS,
  type ServerMessage,
  type SignalingErrorCode,
} from '../shared/signaling';
import type { Logger } from './log';
import { KeyedRateLimiter, TokenBucket } from './rateLimit';
import { RoomError, type Room, RoomManager, type SweepEvent } from './rooms';

export interface Connection {
  readonly ip: string;
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

export interface SignalingLimits {
  maxMessageBytes: number;
  rateLimit: { burst: number; perSecond: number };
  roomCreationsPerMinutePerIp: number;
  joinsPerMinutePerIp: number;
}

type Binding =
  | { role: 'sender'; roomId: string }
  | { role: 'receiver'; roomId: string; sessionId: string };

interface ConnState {
  bucket: TokenBucket;
  binding?: Binding;
  violations: number;
  lastRateLimitNotice: number;
}

export const CLOSE_NORMAL = 1000;
export const CLOSE_POLICY = 1008;
export const CLOSE_UNSUPPORTED = 1003;
/** Session taken over by a newer connection (e.g. the same tab reconnected). */
export const CLOSE_REPLACED = 4001;
export const CLOSE_ROOM_ENDED = 4002;

const MAX_VIOLATIONS = 50;

export interface SignalingStats {
  connections: number;
  rooms: number;
  messagesIn: number;
  bytesIn: number;
  messagesRelayed: number;
  bytesRelayed: number;
}

export class SignalingService {
  private readonly conns = new Map<Connection, ConnState>();
  private readonly senders = new Map<string, Connection>();
  private readonly receivers = new Map<string, Connection>();
  private readonly createLimiter: KeyedRateLimiter;
  private readonly joinLimiter: KeyedRateLimiter;
  private readonly counters = { messagesIn: 0, bytesIn: 0, messagesRelayed: 0, bytesRelayed: 0 };

  constructor(
    readonly rooms: RoomManager,
    private readonly limits: SignalingLimits,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.createLimiter = new KeyedRateLimiter(limits.roomCreationsPerMinutePerIp, limits.roomCreationsPerMinutePerIp / 60, now);
    this.joinLimiter = new KeyedRateLimiter(limits.joinsPerMinutePerIp, limits.joinsPerMinutePerIp / 60, now);
  }

  stats(): SignalingStats {
    return { connections: this.conns.size, rooms: this.rooms.size, ...this.counters };
  }

  connect(conn: Connection): void {
    this.conns.set(conn, {
      bucket: new TokenBucket(this.limits.rateLimit.burst, this.limits.rateLimit.perSecond, this.now),
      violations: 0,
      lastRateLimitNotice: 0,
    });
  }

  message(conn: Connection, raw: string | Buffer, isBinary: boolean): void {
    const state = this.conns.get(conn);
    if (!state) return;
    this.counters.messagesIn++;
    this.counters.bytesIn += typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength;

    if (isBinary) {
      conn.close(CLOSE_UNSUPPORTED, 'binary frames are not accepted');
      return;
    }
    if (!state.bucket.take()) {
      this.violation(conn, state);
      const t = this.now();
      if (t - state.lastRateLimitNotice > 1000) {
        state.lastRateLimitNotice = t;
        this.error(conn, 'rate-limited', 'Too many messages. Slow down.');
      }
      return;
    }
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    if (Buffer.byteLength(text) > this.limits.maxMessageBytes) {
      this.violation(conn, state);
      this.error(conn, 'bad-message', 'Message too large.');
      return;
    }
    const parsed = parseClientMessage(text, this.limits.maxMessageBytes);
    if (!parsed.ok) {
      this.violation(conn, state);
      this.error(conn, 'bad-message', 'Malformed message.');
      return;
    }
    try {
      this.dispatch(conn, state, parsed.message);
    } catch (err) {
      if (err instanceof RoomError) {
        this.error(conn, err.code, err.message);
      } else {
        this.log.error('signaling_dispatch_failed', { message: err instanceof Error ? err.name : 'unknown' });
        this.error(conn, 'bad-message', 'Could not process message.');
      }
    }
  }

  disconnect(conn: Connection): void {
    const state = this.conns.get(conn);
    this.conns.delete(conn);
    const binding = state?.binding;
    if (!binding) return;

    if (binding.role === 'sender') {
      if (this.senders.get(binding.roomId) !== conn) return;
      this.senders.delete(binding.roomId);
      const room = this.tryRoom(binding.roomId);
      if (!room) return;
      this.rooms.setSenderOnline(room, false);
      this.broadcastReceivers(room, { type: 'sender-status', online: false });
    } else {
      const key = receiverKey(binding.roomId, binding.sessionId);
      if (this.receivers.get(key) !== conn) return;
      this.receivers.delete(key);
      const room = this.tryRoom(binding.roomId);
      const receiver = room?.receivers.get(binding.sessionId);
      if (!room || !receiver) return;
      this.rooms.setReceiverOnline(receiver, false);
      this.toSender(room.id, { type: 'receiver-status', sessionId: receiver.sessionId, online: false });
    }
  }

  /** Periodic maintenance: expiry, reconnect grace periods, limiter cleanup. */
  sweep(): void {
    for (const event of this.rooms.sweep()) this.applySweepEvent(event);
    this.createLimiter.evict();
    this.joinLimiter.evict();
  }

  /** Server shutdown: tell everyone and close. */
  shutdown(): void {
    for (const conn of this.conns.keys()) conn.close(1001, 'server shutting down');
  }

  // -------------------------------------------------------------------------

  private dispatch(conn: Connection, state: ConnState, msg: ClientMessage): void {
    if (msg.type === 'ping') {
      conn.send({ type: 'pong' });
      return;
    }
    const binding = state.binding;
    const entry = msg.type === 'create-room' || msg.type === 'resume-sender' || msg.type === 'join' || msg.type === 'resume-receiver';
    if (entry && binding) return this.error(conn, 'already-in-room', 'This connection is already in a room.');
    if (!entry && !binding) return this.error(conn, 'not-in-room', 'Join or create a room first.');

    switch (msg.type) {
      case 'create-room':
        return this.createRoom(conn, state);
      case 'resume-sender':
        return this.resumeSender(conn, state, msg.roomId, msg.senderSecret);
      case 'join':
        return this.join(conn, state, msg.roomId, msg.displayName);
      case 'resume-receiver':
        return this.resumeReceiver(conn, state, msg.roomId, msg.sessionId, msg.sessionSecret);
      default:
        break;
    }

    if (!binding) return;
    const room = this.rooms.getLiveRoom(binding.roomId);

    if (binding.role === 'sender') {
      switch (msg.type) {
        case 'approve': {
          const receiver = this.rooms.getReceiver(room, msg.sessionId);
          if (!receiver.approved) {
            receiver.approved = true;
            this.toReceiver(room.id, receiver.sessionId, { type: 'approved' });
          }
          return;
        }
        case 'remove-receiver': {
          this.rooms.getReceiver(room, msg.sessionId);
          this.rooms.removeReceiver(room, msg.sessionId);
          const target = this.receivers.get(receiverKey(room.id, msg.sessionId));
          if (target) {
            target.send({ type: 'removed', reason: msg.reason });
            this.unbind(target);
            target.close(CLOSE_NORMAL, 'removed');
          }
          return;
        }
        case 'signal': {
          if (!SENDER_SIGNAL_KINDS.has(msg.data.kind)) return this.error(conn, 'forbidden', 'Signal not allowed for sender.');
          if (!msg.to) return this.error(conn, 'bad-message', 'Signal needs a receiver.');
          const receiver = this.rooms.getReceiver(room, msg.to);
          if (!receiver.approved) return this.error(conn, 'not-approved', 'Approve the receiver first.');
          const target = this.receivers.get(receiverKey(room.id, receiver.sessionId));
          if (!target) return this.error(conn, 'peer-offline', 'That receiver is temporarily offline.');
          this.relay(target, { type: 'signal', from: 'sender', data: msg.data });
          return;
        }
        case 'close-room':
          this.endRoom(room, 'stopped');
          return;
        default:
          return this.error(conn, 'forbidden', 'Not allowed for the sender.');
      }
    }

    // Receiver
    const receiver = this.rooms.getReceiver(room, binding.sessionId);
    switch (msg.type) {
      case 'signal': {
        if (!RECEIVER_SIGNAL_KINDS.has(msg.data.kind)) return this.error(conn, 'forbidden', 'Signal not allowed for receiver.');
        if (!receiver.approved) return this.error(conn, 'not-approved', 'Wait for the sender to approve you.');
        const sender = this.senders.get(room.id);
        if (!sender) return this.error(conn, 'peer-offline', 'The sender is temporarily offline.');
        // `msg.to` is deliberately ignored: receivers can only reach the sender.
        this.relay(sender, { type: 'signal', from: receiver.sessionId, data: msg.data });
        return;
      }
      case 'leave': {
        this.rooms.removeReceiver(room, receiver.sessionId);
        this.unbind(conn);
        this.toSender(room.id, { type: 'receiver-left', sessionId: receiver.sessionId, reason: 'left' });
        conn.close(CLOSE_NORMAL, 'left');
        return;
      }
      default:
        return this.error(conn, 'forbidden', 'Not allowed for receivers.');
    }
  }

  private createRoom(conn: Connection, state: ConnState): void {
    if (!this.createLimiter.take(conn.ip)) {
      return this.error(conn, 'rate-limited', 'Too many shares started from this network. Wait a minute and try again.');
    }
    const { room, senderSecret } = this.rooms.createRoom();
    this.bindSender(conn, state, room.id);
    conn.send({
      type: 'room-created',
      roomId: room.id,
      senderSecret,
      expiresAt: room.expiresAt,
      maxReceivers: this.rooms.maxReceiversPerRoom,
    });
    this.log.info('room_created', { rooms: this.rooms.size });
  }

  private resumeSender(conn: Connection, state: ConnState, roomId: string, secret: string): void {
    if (!this.joinLimiter.take(conn.ip)) return this.error(conn, 'rate-limited', 'Too many attempts. Wait a minute.');
    const room = this.rooms.authenticateSender(roomId, secret);
    this.bindSender(conn, state, room.id);
    this.rooms.setSenderOnline(room, true);
    conn.send({
      type: 'sender-resumed',
      roomId: room.id,
      expiresAt: room.expiresAt,
      receivers: [...room.receivers.values()].map(RoomManager.toInfo),
    });
    this.broadcastReceivers(room, { type: 'sender-status', online: true });
  }

  private join(conn: Connection, state: ConnState, roomId: string, displayName?: string): void {
    if (!this.joinLimiter.take(conn.ip)) return this.error(conn, 'rate-limited', 'Too many attempts. Wait a minute.');
    const { room, receiver, sessionSecret } = this.rooms.addReceiver(roomId, displayName);
    this.bindReceiver(conn, state, room.id, receiver.sessionId);
    conn.send({
      type: 'joined',
      roomId: room.id,
      sessionId: receiver.sessionId,
      sessionSecret,
      label: receiver.label,
      displayName: receiver.displayName,
      approved: false,
      senderOnline: room.senderOnline,
      expiresAt: room.expiresAt,
    });
    this.toSender(room.id, { type: 'receiver-joined', receiver: RoomManager.toInfo(receiver) });
    this.log.info('receiver_joined', { receiversInRoom: room.receivers.size });
  }

  private resumeReceiver(conn: Connection, state: ConnState, roomId: string, sessionId: string, secret: string): void {
    if (!this.joinLimiter.take(conn.ip)) return this.error(conn, 'rate-limited', 'Too many attempts. Wait a minute.');
    const { room, receiver } = this.rooms.authenticateReceiver(roomId, sessionId, secret);
    this.bindReceiver(conn, state, room.id, receiver.sessionId);
    this.rooms.setReceiverOnline(receiver, true);
    conn.send({
      type: 'joined',
      roomId: room.id,
      sessionId: receiver.sessionId,
      sessionSecret: secret,
      label: receiver.label,
      displayName: receiver.displayName,
      approved: receiver.approved,
      senderOnline: room.senderOnline,
      expiresAt: room.expiresAt,
    });
    this.toSender(room.id, { type: 'receiver-status', sessionId: receiver.sessionId, online: true });
  }

  private bindSender(conn: Connection, state: ConnState, roomId: string): void {
    const previous = this.senders.get(roomId);
    if (previous && previous !== conn) {
      this.unbind(previous);
      previous.close(CLOSE_REPLACED, 'replaced by a newer connection');
    }
    state.binding = { role: 'sender', roomId };
    this.senders.set(roomId, conn);
  }

  private bindReceiver(conn: Connection, state: ConnState, roomId: string, sessionId: string): void {
    const key = receiverKey(roomId, sessionId);
    const previous = this.receivers.get(key);
    if (previous && previous !== conn) {
      this.unbind(previous);
      previous.close(CLOSE_REPLACED, 'replaced by a newer connection');
    }
    state.binding = { role: 'receiver', roomId, sessionId };
    this.receivers.set(key, conn);
  }

  /** Detaches a connection from its room without triggering offline notifications. */
  private unbind(conn: Connection): void {
    const state = this.conns.get(conn);
    const binding = state?.binding;
    if (!state || !binding) return;
    state.binding = undefined;
    if (binding.role === 'sender') {
      if (this.senders.get(binding.roomId) === conn) this.senders.delete(binding.roomId);
    } else {
      const key = receiverKey(binding.roomId, binding.sessionId);
      if (this.receivers.get(key) === conn) this.receivers.delete(key);
    }
  }

  private endRoom(room: Room, reason: RoomClosedReason): void {
    this.rooms.closeRoom(room.id, reason);
    for (const sessionId of room.receivers.keys()) {
      const target = this.receivers.get(receiverKey(room.id, sessionId));
      if (!target) continue;
      target.send({ type: 'room-closed', reason });
      this.unbind(target);
      target.close(CLOSE_ROOM_ENDED, 'room closed');
    }
    const sender = this.senders.get(room.id);
    if (sender) {
      sender.send({ type: 'room-closed', reason });
      this.unbind(sender);
      sender.close(CLOSE_ROOM_ENDED, 'room closed');
    }
    this.log.info('room_closed', { reason, rooms: this.rooms.size });
  }

  private applySweepEvent(event: SweepEvent): void {
    if (event.type === 'room-closed') {
      this.endRoom(event.room, event.reason);
      return;
    }
    const key = receiverKey(event.room.id, event.sessionId);
    const conn = this.receivers.get(key);
    if (conn) this.unbind(conn);
    this.toSender(event.room.id, { type: 'receiver-left', sessionId: event.sessionId, reason: 'timeout' });
  }

  private tryRoom(roomId: string): Room | undefined {
    try {
      return this.rooms.getLiveRoom(roomId);
    } catch {
      return undefined;
    }
  }

  private toSender(roomId: string, message: ServerMessage): void {
    this.senders.get(roomId)?.send(message);
  }

  private toReceiver(roomId: string, sessionId: string, message: ServerMessage): void {
    this.receivers.get(receiverKey(roomId, sessionId))?.send(message);
  }

  private broadcastReceivers(room: Room, message: ServerMessage): void {
    for (const sessionId of room.receivers.keys()) this.toReceiver(room.id, sessionId, message);
  }

  private relay(target: Connection, message: ServerMessage): void {
    this.counters.messagesRelayed++;
    this.counters.bytesRelayed += JSON.stringify(message.type === 'signal' ? message.data : message).length;
    target.send(message);
  }

  private violation(conn: Connection, state: ConnState): void {
    state.violations++;
    if (state.violations > MAX_VIOLATIONS) conn.close(CLOSE_POLICY, 'too many invalid or excessive messages');
  }

  private error(conn: Connection, code: SignalingErrorCode, message: string): void {
    conn.send({ type: 'error', code, message });
  }
}

function receiverKey(roomId: string, sessionId: string): string {
  return `${roomId}:${sessionId}`;
}
