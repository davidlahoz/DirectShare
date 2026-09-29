import { describe, expect, it } from 'vitest';
import type { ClientMessage, ServerMessage } from '../shared/signaling';
import { silentLogger } from './log';
import { RoomManager } from './rooms';
import { type Connection, SignalingService } from './signaling';

class FakeConn implements Connection {
  readonly inbox: ServerMessage[] = [];
  closed: { code: number; reason: string } | undefined;
  constructor(readonly ip = '10.0.0.1') {}
  send(message: ServerMessage): void {
    if (!this.closed) this.inbox.push(message);
  }
  close(code: number, reason: string): void {
    this.closed ??= { code, reason };
  }
  last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    return [...this.inbox].reverse().find((m) => m.type === type) as Extract<ServerMessage, { type: T }> | undefined;
  }
  all<T extends ServerMessage['type']>(type: T): Array<Extract<ServerMessage, { type: T }>> {
    return this.inbox.filter((m) => m.type === type) as Array<Extract<ServerMessage, { type: T }>>;
  }
}

function setup(opts: { maxReceivers?: number; burst?: number; perSecond?: number; ttlMs?: number; graceMs?: number } = {}) {
  let now = 1_000_000;
  const rooms = new RoomManager({
    ttlMs: opts.ttlMs ?? 3_600_000,
    maxRooms: 100,
    maxReceiversPerRoom: opts.maxReceivers ?? 5,
    reconnectGraceMs: opts.graceMs ?? 30_000,
    now: () => now,
  });
  const service = new SignalingService(
    rooms,
    {
      maxMessageBytes: 64 * 1024,
      rateLimit: { burst: opts.burst ?? 500, perSecond: opts.perSecond ?? 100 },
      roomCreationsPerMinutePerIp: 100,
      joinsPerMinutePerIp: 100,
    },
    silentLogger,
    () => now,
  );
  const open = (ip?: string) => {
    const c = new FakeConn(ip);
    service.connect(c);
    return c;
  };
  const send = (c: FakeConn, msg: ClientMessage | Record<string, unknown>) => service.message(c, JSON.stringify(msg), false);
  const advance = (ms: number) => (now += ms);
  return { service, rooms, open, send, advance };
}

function roomWithReceivers(t: ReturnType<typeof setup>, count: number) {
  const sender = t.open();
  t.send(sender, { type: 'create-room' });
  const created = sender.last('room-created')!;
  const receivers = Array.from({ length: count }, (_, i) => {
    const conn = t.open(`10.0.1.${i}`);
    t.send(conn, { type: 'join', roomId: created.roomId, displayName: `R${i}` });
    return { conn, joined: conn.last('joined')! };
  });
  return { sender, created, receivers };
}

const offer = { kind: 'offer', cid: 'conn-0001', sdp: 'v=0 fake' } as const;
const answer = { kind: 'answer', cid: 'conn-0001', sdp: 'v=0 fake' } as const;

describe('signaling: roles and routing', () => {
  it('creates a room and notifies the sender when receivers join', () => {
    const t = setup();
    const { sender, created, receivers } = roomWithReceivers(t, 2);
    expect(created.roomId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(receivers[0]!.joined.label).toBe('Receiver 1');
    expect(receivers[1]!.joined.label).toBe('Receiver 2');
    expect(receivers[0]!.joined.sessionId).not.toBe(receivers[1]!.joined.sessionId);
    expect(sender.all('receiver-joined').map((m) => m.receiver.displayName)).toEqual(['R0', 'R1']);
  });

  it('routes sender signals only to the named, approved receiver', () => {
    const t = setup();
    const { sender, receivers } = roomWithReceivers(t, 2);
    const [a, b] = receivers;
    t.send(sender, { type: 'signal', to: a!.joined.sessionId, data: offer });
    expect(sender.last('error')?.code).toBe('not-approved');
    expect(a!.conn.all('signal')).toHaveLength(0);

    t.send(sender, { type: 'approve', sessionId: a!.joined.sessionId });
    expect(a!.conn.last('approved')).toBeDefined();
    expect(b!.conn.last('approved')).toBeUndefined();

    t.send(sender, { type: 'signal', to: a!.joined.sessionId, data: offer });
    expect(a!.conn.all('signal')).toEqual([{ type: 'signal', from: 'sender', data: offer }]);
    expect(b!.conn.all('signal')).toHaveLength(0);
  });

  it('delivers receiver signals only to the sender, never to other receivers', () => {
    const t = setup();
    const { sender, receivers } = roomWithReceivers(t, 3);
    const [a, b, c] = receivers;
    for (const r of receivers) t.send(sender, { type: 'approve', sessionId: r.joined.sessionId });

    // Receiver A tries to address receiver B directly: `to` is ignored.
    t.send(a!.conn, { type: 'signal', to: b!.joined.sessionId, data: answer });
    expect(sender.all('signal')).toEqual([{ type: 'signal', from: a!.joined.sessionId, data: answer }]);
    expect(b!.conn.all('signal')).toHaveLength(0);
    expect(c!.conn.all('signal')).toHaveLength(0);
  });

  it('prevents receivers from impersonating the sender or using sender-only actions', () => {
    const t = setup();
    const { sender, receivers } = roomWithReceivers(t, 2);
    const [a, b] = receivers;
    t.send(sender, { type: 'approve', sessionId: a!.joined.sessionId });
    t.send(a!.conn, { type: 'signal', data: offer });
    expect(a!.conn.last('error')?.code).toBe('forbidden');
    t.send(a!.conn, { type: 'approve', sessionId: b!.joined.sessionId });
    expect(a!.conn.last('error')?.code).toBe('forbidden');
    t.send(a!.conn, { type: 'remove-receiver', sessionId: b!.joined.sessionId, reason: 'removed' });
    expect(b!.conn.closed).toBeUndefined();
    t.send(a!.conn, { type: 'close-room' });
    expect(t.rooms.size).toBe(1);
    t.send(a!.conn, { type: 'signal', data: { kind: 'queued', position: 1 } });
    expect(sender.all('signal')).toHaveLength(0);
  });

  it('unapproved receivers cannot signal the sender', () => {
    const t = setup();
    const { sender, receivers } = roomWithReceivers(t, 1);
    t.send(receivers[0]!.conn, { type: 'signal', data: answer });
    expect(receivers[0]!.conn.last('error')?.code).toBe('not-approved');
    expect(sender.all('signal')).toHaveLength(0);
  });

  it('keeps rooms isolated from each other', () => {
    const t = setup();
    const one = roomWithReceivers(t, 1);
    const two = roomWithReceivers(t, 1);
    // Sender of room one addresses the receiver of room two.
    t.send(one.sender, { type: 'approve', sessionId: two.receivers[0]!.joined.sessionId });
    expect(one.sender.last('error')?.code).toBe('unknown-receiver');
    t.send(one.sender, { type: 'signal', to: two.receivers[0]!.joined.sessionId, data: offer });
    expect(two.receivers[0]!.conn.all('signal')).toHaveLength(0);
  });

  it('requires the sender secret to resume control of a room', () => {
    const t = setup();
    const { created, receivers } = roomWithReceivers(t, 1);
    const attacker = t.open('10.9.9.9');
    t.send(attacker, { type: 'resume-sender', roomId: created.roomId, senderSecret: 'A'.repeat(43) });
    expect(attacker.last('error')?.code).toBe('forbidden');
    t.send(attacker, { type: 'approve', sessionId: receivers[0]!.joined.sessionId });
    expect(attacker.last('error')?.code).toBe('not-in-room');
    expect(receivers[0]!.conn.last('approved')).toBeUndefined();

    const legit = t.open();
    t.send(legit, { type: 'resume-sender', roomId: created.roomId, senderSecret: created.senderSecret });
    expect(legit.last('sender-resumed')?.receivers).toHaveLength(1);
  });

  it('never includes the sender secret in messages to receivers', () => {
    const t = setup();
    const { sender, created, receivers } = roomWithReceivers(t, 2);
    t.send(sender, { type: 'approve', sessionId: receivers[0]!.joined.sessionId });
    for (const r of receivers) expect(JSON.stringify(r.conn.inbox)).not.toContain(created.senderSecret);
    // …and receivers never see each other's session secrets.
    expect(JSON.stringify(receivers[0]!.conn.inbox)).not.toContain(receivers[1]!.joined.sessionSecret);
    expect(JSON.stringify(sender.inbox)).not.toContain(receivers[0]!.joined.sessionSecret);
  });
});

describe('signaling: limits and validation', () => {
  it('enforces the receiver limit', () => {
    const t = setup({ maxReceivers: 2 });
    const { created } = roomWithReceivers(t, 2);
    const late = t.open();
    t.send(late, { type: 'join', roomId: created.roomId });
    expect(late.last('error')?.code).toBe('room-full');
  });

  it('rejects malformed and binary messages', () => {
    const t = setup();
    const c = t.open();
    t.service.message(c, '{oops', false);
    expect(c.last('error')?.code).toBe('bad-message');
    t.send(c, { type: 'create-room', extra: 'field' });
    expect(c.last('error')?.code).toBe('bad-message');
    t.service.message(c, Buffer.from([1, 2, 3]), true);
    expect(c.closed?.code).toBe(1003);
  });

  it('rejects oversize messages', () => {
    const t = setup();
    const c = t.open();
    t.service.message(c, 'x'.repeat(70 * 1024), false);
    expect(c.last('error')?.code).toBe('bad-message');
  });

  it('rate limits chatty connections and eventually disconnects them', () => {
    const t = setup({ burst: 10, perSecond: 1 });
    const c = t.open();
    for (let i = 0; i < 10; i++) t.send(c, { type: 'ping' });
    expect(c.all('pong')).toHaveLength(10);
    t.send(c, { type: 'ping' });
    expect(c.last('error')?.code).toBe('rate-limited');
    for (let i = 0; i < 60; i++) t.send(c, { type: 'ping' });
    expect(c.closed?.code).toBe(1008);
  });

  it('cannot join or create twice on one connection', () => {
    const t = setup();
    const { sender, created } = roomWithReceivers(t, 0);
    t.send(sender, { type: 'join', roomId: created.roomId });
    expect(sender.last('error')?.code).toBe('already-in-room');
  });
});

describe('signaling: lifecycle and cleanup', () => {
  it('stopping sharing invalidates the room and disconnects receivers', () => {
    const t = setup();
    const { sender, created, receivers } = roomWithReceivers(t, 2);
    t.send(sender, { type: 'close-room' });
    for (const r of receivers) {
      expect(r.conn.last('room-closed')?.reason).toBe('stopped');
      expect(r.conn.closed).toBeDefined();
    }
    expect(t.rooms.size).toBe(0);
    const late = t.open();
    t.send(late, { type: 'join', roomId: created.roomId });
    expect(late.last('error')?.code).toBe('room-unavailable');
  });

  it('expires rooms and notifies everyone', () => {
    const t = setup({ ttlMs: 60_000 });
    const { sender, receivers } = roomWithReceivers(t, 1);
    t.advance(60_000);
    t.service.sweep();
    expect(sender.last('room-closed')?.reason).toBe('expired');
    expect(receivers[0]!.conn.last('room-closed')?.reason).toBe('expired');
    expect(t.rooms.size).toBe(0);
  });

  it('tells receivers when the sender drops and closes the room after the grace period', () => {
    const t = setup({ graceMs: 30_000 });
    const { sender, receivers } = roomWithReceivers(t, 1);
    t.service.disconnect(sender);
    expect(receivers[0]!.conn.last('sender-status')).toEqual({ type: 'sender-status', online: false });
    t.advance(30_000);
    t.service.sweep();
    expect(receivers[0]!.conn.last('room-closed')?.reason).toBe('sender-left');
  });

  it('lets a sender reconnect within the grace period', () => {
    const t = setup({ graceMs: 30_000 });
    const { sender, created, receivers } = roomWithReceivers(t, 1);
    t.service.disconnect(sender);
    t.advance(10_000);
    const again = t.open();
    t.send(again, { type: 'resume-sender', roomId: created.roomId, senderSecret: created.senderSecret });
    expect(receivers[0]!.conn.last('sender-status')).toEqual({ type: 'sender-status', online: true });
    t.advance(60_000);
    t.service.sweep();
    expect(t.rooms.size).toBe(1);
  });

  it('cleans up disconnected receivers and informs the sender', () => {
    const t = setup({ graceMs: 5_000 });
    const { sender, receivers } = roomWithReceivers(t, 2);
    t.service.disconnect(receivers[0]!.conn);
    expect(sender.last('receiver-status')).toEqual({ type: 'receiver-status', sessionId: receivers[0]!.joined.sessionId, online: false });
    t.advance(5_000);
    t.service.sweep();
    expect(sender.last('receiver-left')).toEqual({ type: 'receiver-left', sessionId: receivers[0]!.joined.sessionId, reason: 'timeout' });
    // The other receiver is unaffected.
    const room = [...(t.rooms as unknown as { rooms: Map<string, { receivers: Map<string, unknown> }> }).rooms.values()][0]!;
    expect(room.receivers.size).toBe(1);
  });

  it('lets a receiver resume its session with its secret', () => {
    const t = setup();
    const { sender, created, receivers } = roomWithReceivers(t, 1);
    const r = receivers[0]!;
    t.send(sender, { type: 'approve', sessionId: r.joined.sessionId });
    t.service.disconnect(r.conn);
    const again = t.open();
    t.send(again, { type: 'resume-receiver', roomId: created.roomId, sessionId: r.joined.sessionId, sessionSecret: r.joined.sessionSecret });
    expect(again.last('joined')?.approved).toBe(true);
    const thief = t.open();
    t.send(thief, { type: 'resume-receiver', roomId: created.roomId, sessionId: r.joined.sessionId, sessionSecret: 'B'.repeat(43) });
    expect(thief.last('error')?.code).toBe('forbidden');
  });

  it('a receiver leaving does not affect the others', () => {
    const t = setup();
    const { sender, receivers } = roomWithReceivers(t, 2);
    for (const r of receivers) t.send(sender, { type: 'approve', sessionId: r.joined.sessionId });
    t.send(receivers[0]!.conn, { type: 'leave' });
    expect(sender.last('receiver-left')?.sessionId).toBe(receivers[0]!.joined.sessionId);
    t.send(sender, { type: 'signal', to: receivers[1]!.joined.sessionId, data: offer });
    expect(receivers[1]!.conn.all('signal')).toHaveLength(1);
  });

  it('only relays negotiation metadata (no file data paths exist)', () => {
    const t = setup();
    const { sender, receivers } = roomWithReceivers(t, 1);
    t.send(sender, { type: 'approve', sessionId: receivers[0]!.joined.sessionId });
    t.send(sender, { type: 'signal', to: receivers[0]!.joined.sessionId, data: { kind: 'offer', cid: 'conn-0001', sdp: 'v=0', chunk: 'AAAA' } as never });
    expect(sender.last('error')?.code).toBe('bad-message');
    expect(receivers[0]!.conn.all('signal')).toHaveLength(0);
  });
});
