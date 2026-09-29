import { describe, expect, it } from 'vitest';
import { RoomError, RoomManager } from './rooms';

function manager(overrides: Partial<ConstructorParameters<typeof RoomManager>[0]> = {}) {
  let now = 1_000_000;
  const rooms = new RoomManager({
    ttlMs: 60_000,
    maxRooms: 3,
    maxReceiversPerRoom: 2,
    reconnectGraceMs: 10_000,
    now: () => now,
    ...overrides,
  });
  return { rooms, advance: (ms: number) => (now += ms) };
}

describe('RoomManager', () => {
  it('creates unguessable room ids and separate sender secrets', () => {
    const { rooms } = manager({ maxRooms: 100 });
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { room, senderSecret } = rooms.createRoom();
      expect(room.id).toMatch(/^[A-Za-z0-9_-]{22}$/); // 128 bits
      expect(senderSecret).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits
      expect(senderSecret).not.toContain(room.id);
      ids.add(room.id);
    }
    expect(ids.size).toBe(50);
  });

  it('authorizes the sender only with the right secret', () => {
    const { rooms } = manager();
    const { room, senderSecret } = rooms.createRoom();
    expect(rooms.authenticateSender(room.id, senderSecret)).toBe(room);
    expect(() => rooms.authenticateSender(room.id, 'x'.repeat(43))).toThrow(RoomError);
  });

  it('assigns unique session ids and anonymous labels', () => {
    const { rooms } = manager();
    const { room } = rooms.createRoom();
    const a = rooms.addReceiver(room.id);
    const b = rooms.addReceiver(room.id, '  Ana  ');
    expect(a.receiver.sessionId).not.toBe(b.receiver.sessionId);
    expect(a.receiver.label).toBe('Receiver 1');
    expect(b.receiver.label).toBe('Receiver 2');
    expect(b.receiver.displayName).toBe('Ana');
    expect(rooms.authenticateReceiver(room.id, a.receiver.sessionId, a.sessionSecret).receiver).toBe(a.receiver);
    expect(() => rooms.authenticateReceiver(room.id, a.receiver.sessionId, b.sessionSecret)).toThrow(RoomError);
  });

  it('enforces the receiver limit', () => {
    const { rooms } = manager();
    const { room } = rooms.createRoom();
    rooms.addReceiver(room.id);
    rooms.addReceiver(room.id);
    expect(() => rooms.addReceiver(room.id)).toThrow(expect.objectContaining({ code: 'room-full' }));
  });

  it('enforces the global room limit', () => {
    const { rooms } = manager();
    rooms.createRoom();
    rooms.createRoom();
    rooms.createRoom();
    expect(() => rooms.createRoom()).toThrow(expect.objectContaining({ code: 'server-busy' }));
  });

  it('expires rooms and reports them once', () => {
    const { rooms, advance } = manager();
    const { room } = rooms.createRoom();
    advance(59_999);
    expect(rooms.sweep()).toEqual([]);
    advance(1);
    expect(() => rooms.getLiveRoom(room.id)).toThrow(expect.objectContaining({ closedReason: 'expired' }));
    const events = rooms.sweep();
    expect(events).toEqual([expect.objectContaining({ type: 'room-closed', reason: 'expired' })]);
    expect(rooms.sweep()).toEqual([]);
    expect(rooms.size).toBe(0);
    expect(() => rooms.addReceiver(room.id)).toThrow(expect.objectContaining({ code: 'room-unavailable', closedReason: 'expired' }));
  });

  it('closes a room whose sender stays disconnected past the grace period', () => {
    const { rooms, advance } = manager();
    const { room } = rooms.createRoom();
    rooms.setSenderOnline(room, false);
    advance(9_000);
    expect(rooms.sweep()).toEqual([]);
    rooms.setSenderOnline(room, true); // reconnected in time
    advance(20_000);
    expect(rooms.sweep()).toEqual([]);
    rooms.setSenderOnline(room, false);
    advance(10_000);
    expect(rooms.sweep()).toEqual([expect.objectContaining({ type: 'room-closed', reason: 'sender-left' })]);
  });

  it('removes receivers that stay disconnected past the grace period', () => {
    const { rooms, advance } = manager();
    const { room } = rooms.createRoom();
    const { receiver } = rooms.addReceiver(room.id);
    rooms.setReceiverOnline(receiver, false);
    advance(10_000);
    expect(rooms.sweep()).toEqual([expect.objectContaining({ type: 'receiver-timeout', sessionId: receiver.sessionId })]);
    expect(room.receivers.size).toBe(0);
  });

  it('rejects joins after the sender stopped sharing', () => {
    const { rooms } = manager();
    const { room } = rooms.createRoom();
    rooms.closeRoom(room.id, 'stopped');
    expect(() => rooms.addReceiver(room.id)).toThrow(expect.objectContaining({ closedReason: 'stopped' }));
    expect(() => rooms.getLiveRoom('A'.repeat(22))).toThrow(expect.objectContaining({ code: 'room-unavailable' }));
  });
});
