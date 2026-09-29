import { describe, expect, it } from 'vitest';
import { deliveredFileIds, emptyHistory, type HistoryRecord, recordOutcome, summarizeHistory } from './downloadHistory';

const rec = (over: Partial<HistoryRecord>): HistoryRecord => ({
  receiverId: 'r1',
  receiverName: 'Receiver 1',
  fileId: 'f1',
  fileName: 'a.txt',
  size: 10,
  completedAt: 1000,
  transferId: 't1',
  kind: 'confirmed',
  ...over,
});

describe('download history', () => {
  it('records each (receiver, file) confirmation once, however often it is acknowledged', () => {
    let h = emptyHistory;
    h = recordOutcome(h, rec({}));
    const again = recordOutcome(h, rec({ completedAt: 2000 }));
    expect(again).toBe(h); // unchanged reference: no re-render, no duplicate
    h = recordOutcome(again, rec({ transferId: 't2', completedAt: 3000 }));
    expect(h.records).toHaveLength(1);
    expect(h.records[0]!.completedAt).toBe(1000);
  });

  it('keeps receivers separate', () => {
    let h = emptyHistory;
    h = recordOutcome(h, rec({ receiverId: 'r1' }));
    h = recordOutcome(h, rec({ receiverId: 'r2', receiverName: 'Ana' }));
    expect(h.records).toHaveLength(2);
  });

  it('upgrades unconfirmed to confirmed after a retry but never downgrades', () => {
    let h = emptyHistory;
    h = recordOutcome(h, rec({ kind: 'unconfirmed', transferId: 't1' }));
    h = recordOutcome(h, rec({ kind: 'confirmed', transferId: 't2', completedAt: 5000 }));
    expect(h.records).toEqual([expect.objectContaining({ kind: 'confirmed', transferId: 't2' })]);
    const after = recordOutcome(h, rec({ kind: 'unconfirmed', transferId: 't3' }));
    expect(after).toBe(h);
    const after2 = recordOutcome(h, rec({ kind: 'save-unconfirmed', transferId: 't4' }));
    expect(after2).toBe(h);
  });

  it('keeps successful, save-unconfirmed and unconfirmed outcomes apart', () => {
    let h = emptyHistory;
    h = recordOutcome(h, rec({ fileId: 'f1', kind: 'confirmed' }));
    h = recordOutcome(h, rec({ receiverId: 'r2', fileId: 'f1', kind: 'save-unconfirmed' }));
    h = recordOutcome(h, rec({ receiverId: 'r3', fileId: 'f1', kind: 'unconfirmed' }));
    const s = summarizeHistory(h, ['f1']);
    expect(s.successfulCount).toBe(1);
    expect(s.successful.map((g) => g.receiverId)).toEqual(['r1']);
    expect(s.saveUnconfirmed.map((r) => r.receiverId)).toEqual(['r2']);
    expect(s.unconfirmed.map((r) => r.receiverId)).toEqual(['r3']);
    expect(s.completeReceivers).toBe(1);
  });

  it('groups by receiver and counts receivers with the complete file set', () => {
    let h = emptyHistory;
    h = recordOutcome(h, rec({ receiverId: 'r1', fileId: 'f1', completedAt: 1 }));
    h = recordOutcome(h, rec({ receiverId: 'r1', fileId: 'f2', completedAt: 2 }));
    h = recordOutcome(h, rec({ receiverId: 'r2', fileId: 'f1', completedAt: 3 }));
    const s = summarizeHistory(h, ['f1', 'f2']);
    expect(s.completeReceivers).toBe(1);
    const r1 = s.successful.find((g) => g.receiverId === 'r1')!;
    const r2 = s.successful.find((g) => g.receiverId === 'r2')!;
    expect(r1.receivedAll).toBe(true);
    expect(r2.receivedAll).toBe(false);
    expect(s.successful[0]!.receiverId).toBe('r2'); // most recent activity first
  });

  it('save-unconfirmed deliveries never count toward the complete set', () => {
    let h = emptyHistory;
    h = recordOutcome(h, rec({ fileId: 'f1', kind: 'confirmed' }));
    h = recordOutcome(h, rec({ fileId: 'f2', kind: 'save-unconfirmed' }));
    expect(summarizeHistory(h, ['f1', 'f2']).completeReceivers).toBe(0);
  });

  it('lists delivered files so retries skip them, but not unconfirmed ones', () => {
    let h = emptyHistory;
    h = recordOutcome(h, rec({ fileId: 'f1', kind: 'confirmed' }));
    h = recordOutcome(h, rec({ fileId: 'f2', kind: 'save-unconfirmed' }));
    h = recordOutcome(h, rec({ fileId: 'f3', kind: 'unconfirmed' }));
    expect([...deliveredFileIds(h, 'r1')].sort()).toEqual(['f1', 'f2']);
    expect(deliveredFileIds(h, 'other').size).toBe(0);
  });
});
