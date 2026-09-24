import { describe, expect, it } from 'vitest';

import {
  recordEventDeliveryTiming,
  recordPushDeliveryFailure,
  type WorkerMetrics,
} from './observability.js';

describe('worker observability adapters', () => {
  it('records push failures without receiving push credentials', () => {
    const increments: Array<{ name: string; labels?: Readonly<Record<string, string>> }> = [];
    const metrics: WorkerMetrics = {
      increment: (name, labels) =>
        increments.push({ name, ...(labels === undefined ? {} : { labels }) }),
    };

    recordPushDeliveryFailure(metrics, {
      gameId: 'game-1',
      participantId: 'participant-1',
      reason: 'subscription_expired',
    });

    expect(increments).toEqual([
      {
        name: 'human_bingo_push_failure_total',
        labels: { reason: 'subscription_expired' },
      },
    ]);
  });

  it('records event delivery count and timing', () => {
    const increments: string[] = [];
    const observations: Array<{
      name: string;
      value: number;
      labels?: Readonly<Record<string, string>>;
    }> = [];
    const metrics: WorkerMetrics = {
      increment: (name) => increments.push(name),
      observe: (name, value, labels) =>
        observations.push({ name, value, ...(labels === undefined ? {} : { labels }) }),
    };

    recordEventDeliveryTiming(metrics, { durationMs: 25, outcome: 'delivered' });

    expect(increments).toEqual(['human_bingo_event_delivery_total']);
    expect(observations).toEqual([
      {
        name: 'human_bingo_event_delivery_duration_ms',
        value: 25,
        labels: { outcome: 'delivered' },
      },
    ]);
  });
});
