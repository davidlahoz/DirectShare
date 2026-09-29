/**
 * Sender-side download history for the current sharing session.
 *
 * Three separate outcome kinds, never mixed:
 *  - `confirmed`: the receiving app reported that all bytes arrived, checks
 *    passed, writes completed and the destination file closed.
 *  - `save-unconfirmed`: delivered to the receiver's browser download manager
 *    (memory fallback). The app cannot confirm the save.
 *  - `unconfirmed`: all bytes were sent but the connection dropped before the
 *    receiver's completion acknowledgement arrived.
 *
 * One record per (receiver, file). Recording is idempotent: repeated
 * acknowledgements never create duplicates. A later confirmation upgrades an
 * earlier unconfirmed record (e.g. after a retry); nothing downgrades a
 * confirmed record.
 *
 * These are receiver-reported application confirmations, not independent
 * proof that a device still holds the file.
 */

export type HistoryKind = 'confirmed' | 'save-unconfirmed' | 'unconfirmed';

export interface HistoryRecord {
  receiverId: string;
  receiverName: string;
  fileId: string;
  fileName: string;
  size: number;
  completedAt: number;
  transferId: string;
  kind: HistoryKind;
}

export interface HistoryState {
  readonly records: readonly HistoryRecord[];
}

export const emptyHistory: HistoryState = { records: [] };

const RANK: Record<HistoryKind, number> = { unconfirmed: 0, 'save-unconfirmed': 1, confirmed: 2 };

const keyOf = (r: Pick<HistoryRecord, 'receiverId' | 'fileId'>) => `${r.receiverId}\u0000${r.fileId}`;

/** Returns a new state with `record` applied, or the same state if nothing changed. */
export function recordOutcome(state: HistoryState, record: HistoryRecord): HistoryState {
  const key = keyOf(record);
  const index = state.records.findIndex((r) => keyOf(r) === key);
  if (index === -1) return { records: [...state.records, record] };
  const existing = state.records[index]!;
  if (RANK[record.kind] <= RANK[existing.kind]) return state;
  const records = state.records.slice();
  records.splice(index, 1);
  records.push(record);
  return { records };
}

/** Files already delivered to a receiver (confirmed or handed to its browser); retries skip these. */
export function deliveredFileIds(state: HistoryState, receiverId: string): Set<string> {
  return new Set(
    state.records.filter((r) => r.receiverId === receiverId && r.kind !== 'unconfirmed').map((r) => r.fileId),
  );
}

export interface ReceiverHistoryGroup {
  receiverId: string;
  receiverName: string;
  records: HistoryRecord[];
  /** True when every shared file is confirmed for this receiver. */
  receivedAll: boolean;
  lastCompletedAt: number;
}

export interface HistorySummary {
  /** Confirmed downloads grouped by receiver, most recent activity first. */
  successful: ReceiverHistoryGroup[];
  successfulCount: number;
  /** Receivers that confirmed the complete file set. */
  completeReceivers: number;
  saveUnconfirmed: HistoryRecord[];
  unconfirmed: HistoryRecord[];
}

export function summarizeHistory(state: HistoryState, sharedFileIds: readonly string[]): HistorySummary {
  const groups = new Map<string, ReceiverHistoryGroup>();
  const saveUnconfirmed: HistoryRecord[] = [];
  const unconfirmed: HistoryRecord[] = [];
  let successfulCount = 0;

  for (const record of state.records) {
    if (record.kind === 'save-unconfirmed') {
      saveUnconfirmed.push(record);
      continue;
    }
    if (record.kind === 'unconfirmed') {
      unconfirmed.push(record);
      continue;
    }
    successfulCount++;
    let group = groups.get(record.receiverId);
    if (!group) {
      group = { receiverId: record.receiverId, receiverName: record.receiverName, records: [], receivedAll: false, lastCompletedAt: 0 };
      groups.set(record.receiverId, group);
    }
    group.records.push(record);
    group.receiverName = record.receiverName;
    group.lastCompletedAt = Math.max(group.lastCompletedAt, record.completedAt);
  }

  const wanted = new Set(sharedFileIds);
  let completeReceivers = 0;
  for (const group of groups.values()) {
    const got = new Set(group.records.map((r) => r.fileId));
    group.receivedAll = wanted.size > 0 && [...wanted].every((id) => got.has(id));
    group.records.sort((a, b) => a.completedAt - b.completedAt);
    if (group.receivedAll) completeReceivers++;
  }

  return {
    successful: [...groups.values()].sort((a, b) => b.lastCompletedAt - a.lastCompletedAt),
    successfulCount,
    completeReceivers,
    saveUnconfirmed,
    unconfirmed,
  };
}
