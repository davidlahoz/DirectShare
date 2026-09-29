import { describe, expect, it } from 'vitest';
import { planSchedule, type SchedulableReceiver } from './scheduler';

const r = (sessionId: string, status: SchedulableReceiver['status'], queuedAt = 0, online = true): SchedulableReceiver => ({
  sessionId,
  status,
  queuedAt,
  online,
});

describe('transfer scheduler', () => {
  it('starts queued receivers up to the concurrency limit in approval order', () => {
    const plan = planSchedule([r('c', 'queued', 3), r('a', 'queued', 1), r('b', 'queued', 2), r('d', 'queued', 4)], 2);
    expect(plan.start).toEqual(['a', 'b']);
    expect([...plan.positions]).toEqual([
      ['c', 1],
      ['d', 2],
    ]);
  });

  it('counts connecting and transferring receivers against the limit', () => {
    const plan = planSchedule([r('x', 'transferring'), r('y', 'connecting'), r('z', 'awaiting-acceptance'), r('q', 'queued', 1)], 3);
    expect(plan.start).toEqual([]);
    expect(plan.positions.get('q')).toBe(1);
  });

  it('frees a slot when a transfer fails, completes or is canceled', () => {
    const plan = planSchedule([r('x', 'failed'), r('y', 'completed'), r('w', 'canceled'), r('q', 'queued', 1)], 1);
    expect(plan.start).toEqual(['q']);
  });

  it('skips offline receivers without blocking the rest of the queue', () => {
    const plan = planSchedule([r('off', 'queued', 1, false), r('on', 'queued', 2)], 1);
    expect(plan.start).toEqual(['on']);
    expect(plan.positions.get('off')).toBe(1);
  });

  it('ignores receivers awaiting approval', () => {
    expect(planSchedule([r('p', 'awaiting-approval')], 5).start).toEqual([]);
  });
});
