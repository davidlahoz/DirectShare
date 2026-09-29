/**
 * WebSocket signaling protocol (JSON text frames).
 *
 * The protocol version is negotiated through the WebSocket subprotocol
 * (`directsend.v1`). The server only ever sees room coordination and WebRTC
 * session descriptions / ICE candidates. File names, sizes and contents are
 * exchanged exclusively over the peer-to-peer DataChannel.
 */
import { z } from 'zod';

export const SIGNALING_SUBPROTOCOL = 'directsend.v1';
export const SIGNALING_PATH = '/ws';

export const MAX_SDP_LENGTH = 32 * 1024;
export const MAX_SIGNALING_MESSAGE_BYTES = 64 * 1024;

/** Room and session identifiers: 128-bit random values, base64url encoded. */
export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
/** Bearer secrets: 256-bit random values, base64url encoded. */
export const secretSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
/** Per-connection-attempt identifier chosen by the sender. */
export const connectionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export const iceCandidateSchema = z
  .object({
    candidate: z.string().max(2048),
    sdpMid: z.string().max(64).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
    usernameFragment: z.string().max(256).nullable().optional(),
  })
  .strict();

const sdp = z.string().min(1).max(MAX_SDP_LENGTH);

/** Payloads relayed between sender and one receiver. */
export const signalDataSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('offer'), cid: connectionIdSchema, sdp }).strict(),
  z.object({ kind: z.literal('answer'), cid: connectionIdSchema, sdp }).strict(),
  z.object({ kind: z.literal('candidate'), cid: connectionIdSchema, candidate: iceCandidateSchema }).strict(),
  /** Sender tells an approved receiver it is waiting for a free transfer slot. */
  z.object({ kind: z.literal('queued'), position: z.number().int().min(1).max(10_000) }).strict(),
  /** Receiver asks the sender to try the transfer again (new connection, new transfer id). */
  z.object({ kind: z.literal('retry-request') }).strict(),
  /** Either side abandons a connection attempt. */
  z.object({ kind: z.literal('hangup'), cid: connectionIdSchema }).strict(),
]);
export type SignalData = z.infer<typeof signalDataSchema>;
export type SignalKind = SignalData['kind'];

/** Which signal kinds each role may originate. Enforced by the server. */
export const SENDER_SIGNAL_KINDS: ReadonlySet<SignalKind> = new Set(['offer', 'candidate', 'queued', 'hangup']);
export const RECEIVER_SIGNAL_KINDS: ReadonlySet<SignalKind> = new Set(['answer', 'candidate', 'retry-request', 'hangup']);

const displayNameInput = z.string().max(200).optional();

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create-room') }).strict(),
  z.object({ type: z.literal('resume-sender'), roomId: idSchema, senderSecret: secretSchema }).strict(),
  z.object({ type: z.literal('join'), roomId: idSchema, displayName: displayNameInput }).strict(),
  z
    .object({ type: z.literal('resume-receiver'), roomId: idSchema, sessionId: idSchema, sessionSecret: secretSchema })
    .strict(),
  z.object({ type: z.literal('approve'), sessionId: idSchema }).strict(),
  z
    .object({ type: z.literal('remove-receiver'), sessionId: idSchema, reason: z.enum(['denied', 'removed']) })
    .strict(),
  z.object({ type: z.literal('signal'), to: idSchema.optional(), data: signalDataSchema }).strict(),
  z.object({ type: z.literal('close-room') }).strict(),
  z.object({ type: z.literal('leave') }).strict(),
  z.object({ type: z.literal('ping') }).strict(),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const receiverInfoSchema = z
  .object({
    sessionId: idSchema,
    label: z.string().max(64),
    displayName: z.string().max(200).optional(),
    approved: z.boolean(),
    online: z.boolean(),
  })
  .strict();
export type ReceiverInfo = z.infer<typeof receiverInfoSchema>;

export const ERROR_CODES = [
  'bad-message',
  'rate-limited',
  'not-in-room',
  'already-in-room',
  'forbidden',
  'room-unavailable',
  'room-full',
  'server-busy',
  'unknown-receiver',
  'not-approved',
  'peer-offline',
] as const;
export type SignalingErrorCode = (typeof ERROR_CODES)[number];

export const ROOM_CLOSED_REASONS = ['stopped', 'expired', 'sender-left'] as const;
export type RoomClosedReason = (typeof ROOM_CLOSED_REASONS)[number];

export const serverMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('room-created'),
      roomId: idSchema,
      senderSecret: secretSchema,
      expiresAt: z.number(),
      maxReceivers: z.number().int(),
    })
    .strict(),
  z
    .object({
      type: z.literal('sender-resumed'),
      roomId: idSchema,
      expiresAt: z.number(),
      receivers: z.array(receiverInfoSchema).max(1000),
    })
    .strict(),
  z
    .object({
      type: z.literal('joined'),
      roomId: idSchema,
      sessionId: idSchema,
      sessionSecret: secretSchema,
      label: z.string().max(64),
      displayName: z.string().max(200).optional(),
      approved: z.boolean(),
      senderOnline: z.boolean(),
      expiresAt: z.number(),
    })
    .strict(),
  z.object({ type: z.literal('receiver-joined'), receiver: receiverInfoSchema }).strict(),
  z.object({ type: z.literal('receiver-status'), sessionId: idSchema, online: z.boolean() }).strict(),
  z
    .object({ type: z.literal('receiver-left'), sessionId: idSchema, reason: z.enum(['left', 'timeout']) })
    .strict(),
  z.object({ type: z.literal('approved') }).strict(),
  z.object({ type: z.literal('removed'), reason: z.enum(['denied', 'removed']) }).strict(),
  z.object({ type: z.literal('sender-status'), online: z.boolean() }).strict(),
  z
    .object({ type: z.literal('signal'), from: z.union([idSchema, z.literal('sender')]), data: signalDataSchema })
    .strict(),
  z.object({ type: z.literal('room-closed'), reason: z.enum(ROOM_CLOSED_REASONS) }).strict(),
  z.object({ type: z.literal('error'), code: z.enum(ERROR_CODES), message: z.string().max(500) }).strict(),
  z.object({ type: z.literal('pong') }).strict(),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export type ParseResult<T> = { ok: true; message: T } | { ok: false; error: string };

function parseJson(raw: string, maxBytes: number): ParseResult<unknown> {
  // Length in UTF-16 code units is a cheap lower bound of the UTF-8 size.
  if (raw.length > maxBytes) return { ok: false, error: 'message too large' };
  try {
    return { ok: true, message: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
}

export function parseClientMessage(raw: string, maxBytes = MAX_SIGNALING_MESSAGE_BYTES): ParseResult<ClientMessage> {
  const json = parseJson(raw, maxBytes);
  if (!json.ok) return json;
  const result = clientMessageSchema.safeParse(json.message);
  return result.success ? { ok: true, message: result.data } : { ok: false, error: 'invalid message shape' };
}

export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  const json = parseJson(raw, MAX_SIGNALING_MESSAGE_BYTES * 4);
  if (!json.ok) return json;
  const result = serverMessageSchema.safeParse(json.message);
  return result.success ? { ok: true, message: result.data } : { ok: false, error: 'invalid message shape' };
}
