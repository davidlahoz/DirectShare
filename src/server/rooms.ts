/**
 * Room creation and peer pairing. Pure in-memory state with an injectable
 * clock, independent of the WebSocket layer so it can be unit tested.
 *
 * Rooms hold no file information at all: only who is in the room, who is
 * approved, and when the room expires.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ReceiverInfo, RoomClosedReason } from '../shared/signaling';
import { sanitizeDisplayName } from '../shared/sanitize';

export function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function secretMatches(secret: string, expectedHash: Buffer): boolean {
  return timingSafeEqual(hashSecret(secret), expectedHash);
}

export interface ReceiverRecord {
  sessionId: string;
  secretHash: Buffer;
  label: string;
  displayName?: string;
  approved: boolean;
  online: boolean;
  offlineSince?: number;
}

export interface Room {
  id: string;
  senderSecretHash: Buffer;
  createdAt: number;
  expiresAt: number;
  senderOnline: boolean;
  senderOfflineSince?: number;
  receivers: Map<string, ReceiverRecord>;
  nextLabel: number;
}

export type RoomErrorCode = 'room-unavailable' | 'room-full' | 'server-busy' | 'forbidden' | 'unknown-receiver';

export class RoomError extends Error {
  constructor(
    readonly code: RoomErrorCode,
    message: string,
    readonly closedReason?: RoomClosedReason,
  ) {
    super(message);
  }
}

export type SweepEvent =
  | { type: 'room-closed'; room: Room; reason: RoomClosedReason }
  | { type: 'receiver-timeout'; room: Room; sessionId: string };

export interface RoomManagerOptions {
  ttlMs: number;
  maxRooms: number;
  maxReceiversPerRoom: number;
  reconnectGraceMs: number;
  now?: () => number;
}

const MAX_TOMBSTONES = 50_000;

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  /** Recently closed room ids, remembered so late joiners get a precise message. */
  private readonly tombstones = new Map<string, { reason: RoomClosedReason; until: number }>();
  private readonly now: () => number;

  constructor(private readonly opts: RoomManagerOptions) {
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.rooms.size;
  }

  get maxReceiversPerRoom(): number {
    return this.opts.maxReceiversPerRoom;
  }

  createRoom(): { room: Room; senderSecret: string } {
    if (this.rooms.size >= this.opts.maxRooms) {
      throw new RoomError('server-busy', 'The server is handling too many shares right now. Try again shortly.');
    }
    const id = randomToken(16);
    const senderSecret = randomToken(32);
    const now = this.now();
    const room: Room = {
      id,
      senderSecretHash: hashSecret(senderSecret),
      createdAt: now,
      expiresAt: now + this.opts.ttlMs,
      senderOnline: true,
      receivers: new Map(),
      nextLabel: 1,
    };
    this.rooms.set(id, room);
    return { room, senderSecret };
  }

  /** Returns a live room or throws a RoomError describing why it is unavailable. */
  getLiveRoom(roomId: string): Room {
    const room = this.rooms.get(roomId);
    if (room && room.expiresAt > this.now()) return room;
    // Expired rooms are closed (and their peers notified) by sweep().
    if (room) throw new RoomError('room-unavailable', 'This sharing link has expired.', 'expired');
    const tomb = this.tombstones.get(roomId);
    if (tomb) {
      const message =
        tomb.reason === 'expired' ? 'This sharing link has expired.' : 'The sender is no longer sharing these files.';
      throw new RoomError('room-unavailable', message, tomb.reason);
    }
    throw new RoomError('room-unavailable', 'This sharing link is not valid or has ended.');
  }

  authenticateSender(roomId: string, senderSecret: string): Room {
    const room = this.getLiveRoom(roomId);
    if (!secretMatches(senderSecret, room.senderSecretHash)) {
      throw new RoomError('forbidden', 'Not authorized to control this room.');
    }
    return room;
  }

  addReceiver(roomId: string, rawDisplayName?: string): { room: Room; receiver: ReceiverRecord; sessionSecret: string } {
    const room = this.getLiveRoom(roomId);
    if (room.receivers.size >= this.opts.maxReceiversPerRoom) {
      throw new RoomError('room-full', 'This share has reached its receiver limit. Ask the sender for a new link.');
    }
    const sessionSecret = randomToken(32);
    const receiver: ReceiverRecord = {
      sessionId: randomToken(16),
      secretHash: hashSecret(sessionSecret),
      label: `Receiver ${room.nextLabel++}`,
      displayName: sanitizeDisplayName(rawDisplayName),
      approved: false,
      online: true,
    };
    room.receivers.set(receiver.sessionId, receiver);
    return { room, receiver, sessionSecret };
  }

  authenticateReceiver(roomId: string, sessionId: string, sessionSecret: string): { room: Room; receiver: ReceiverRecord } {
    const room = this.getLiveRoom(roomId);
    const receiver = room.receivers.get(sessionId);
    if (!receiver || !secretMatches(sessionSecret, receiver.secretHash)) {
      throw new RoomError('forbidden', 'This receiver session is no longer valid. Open the link again.');
    }
    return { room, receiver };
  }

  getReceiver(room: Room, sessionId: string): ReceiverRecord {
    const receiver = room.receivers.get(sessionId);
    if (!receiver) throw new RoomError('unknown-receiver', 'That receiver is no longer in the room.');
    return receiver;
  }

  setSenderOnline(room: Room, online: boolean): void {
    room.senderOnline = online;
    room.senderOfflineSince = online ? undefined : this.now();
  }

  setReceiverOnline(receiver: ReceiverRecord, online: boolean): void {
    receiver.online = online;
    receiver.offlineSince = online ? undefined : this.now();
  }

  removeReceiver(room: Room, sessionId: string): boolean {
    return room.receivers.delete(sessionId);
  }

  closeRoom(roomId: string, reason: RoomClosedReason): Room | undefined {
    const room = this.rooms.get(roomId);
    this.rooms.delete(roomId);
    if (this.tombstones.size >= MAX_TOMBSTONES) {
      const oldest = this.tombstones.keys().next().value;
      if (oldest !== undefined) this.tombstones.delete(oldest);
    }
    // Remember at least as long as the room would have lived, capped at a day.
    const until = this.now() + Math.min(Math.max(room ? room.expiresAt - this.now() : 0, 3600_000), 86_400_000);
    this.tombstones.set(roomId, { reason, until });
    return room;
  }

  /** Expires rooms and releases peers whose reconnect grace period ran out. */
  sweep(): SweepEvent[] {
    const now = this.now();
    const events: SweepEvent[] = [];
    for (const room of [...this.rooms.values()]) {
      if (room.expiresAt <= now) {
        this.closeRoom(room.id, 'expired');
        events.push({ type: 'room-closed', room, reason: 'expired' });
        continue;
      }
      if (!room.senderOnline && room.senderOfflineSince !== undefined && now - room.senderOfflineSince >= this.opts.reconnectGraceMs) {
        this.closeRoom(room.id, 'sender-left');
        events.push({ type: 'room-closed', room, reason: 'sender-left' });
        continue;
      }
      for (const receiver of [...room.receivers.values()]) {
        if (!receiver.online && receiver.offlineSince !== undefined && now - receiver.offlineSince >= this.opts.reconnectGraceMs) {
          room.receivers.delete(receiver.sessionId);
          events.push({ type: 'receiver-timeout', room, sessionId: receiver.sessionId });
        }
      }
    }
    for (const [id, tomb] of this.tombstones) {
      if (tomb.until <= now) this.tombstones.delete(id);
    }
    return events;
  }

  static toInfo(receiver: ReceiverRecord): ReceiverInfo {
    return {
      sessionId: receiver.sessionId,
      label: receiver.label,
      displayName: receiver.displayName,
      approved: receiver.approved,
      online: receiver.online,
    };
  }
}
