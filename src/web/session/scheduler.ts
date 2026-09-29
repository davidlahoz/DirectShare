/**
 * Decides which approved receivers may start. Each receiver has its own
 * connection; at most `maxConcurrent` are connecting or transferring at once
 * and the rest wait in approval order.
 */
export type ReceiverStatus =
  | 'awaiting-approval'
  | 'queued'
  | 'connecting'
  | 'awaiting-acceptance'
  | 'transferring'
  | 'completed'
  | 'save-unconfirmed'
  | 'rejected'
  | 'canceled'
  | 'failed'
  | 'denied'
  | 'left';

export const ACTIVE_STATUSES: ReadonlySet<ReceiverStatus> = new Set(['connecting', 'awaiting-acceptance', 'transferring']);

export interface SchedulableReceiver {
  sessionId: string;
  status: ReceiverStatus;
  /** When the receiver entered the queue; earlier goes first. */
  queuedAt?: number;
  /** Queued receivers who are offline on signaling cannot be connected yet. */
  online: boolean;
}

export interface SchedulePlan {
  start: string[];
  /** 1-based queue positions for receivers still waiting. */
  positions: Map<string, number>;
}

export function planSchedule(receivers: readonly SchedulableReceiver[], maxConcurrent: number): SchedulePlan {
  const active = receivers.filter((r) => ACTIVE_STATUSES.has(r.status)).length;
  const queued = receivers
    .filter((r) => r.status === 'queued')
    .sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0));
  let free = Math.max(0, maxConcurrent - active);
  const start: string[] = [];
  const positions = new Map<string, number>();
  let position = 1;
  for (const r of queued) {
    if (free > 0 && r.online) {
      start.push(r.sessionId);
      free--;
    } else {
      positions.set(r.sessionId, position++);
    }
  }
  return { start, positions };
}
