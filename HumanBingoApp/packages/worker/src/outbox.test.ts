import { describe, expect, it } from 'vitest';
import {
  IdempotentEventConsumer,
  OutboxPublisher,
  OutboxWorkConsumer,
  type OutboxStore,
} from './outbox.js';

type Event = { readonly id: string; readonly value: string };

class FakeOutboxStore implements OutboxStore<Event> {
  readonly published: string[] = [];
  readonly failures: Array<{ id: string; error: string }> = [];
  readonly events: Event[];

  public constructor(events: readonly Event[]) {
    this.events = [...events];
  }

  public claimPending(): Promise<readonly Event[]> {
    return Promise.resolve(this.events.filter((event) => !this.published.includes(event.id)));
  }

  public markPublished(eventId: string): Promise<void> {
    this.published.push(eventId);
    return Promise.resolve();
  }

  public markFailed(eventId: string, _failedAt: Date, error: string): Promise<void> {
    this.failures.push({ id: eventId, error });
    return Promise.resolve();
  }
}

describe('outbox resilience', () => {
  it('keeps committed events retryable when the broker is unavailable', async () => {
    const store = new FakeOutboxStore([{ id: 'event-1', value: 'patch' }]);
    let available = false;
    const publisher = new OutboxPublisher(store, {
      publish: async () => {
        await Promise.resolve();
        if (!available) throw new Error('broker unavailable');
      },
    });

    await expect(publisher.publishPending()).resolves.toEqual({
      attempted: 1,
      published: 0,
      failed: 1,
    });
    expect(store.published).toEqual([]);
    expect(store.failures).toEqual([{ id: 'event-1', error: 'broker unavailable' }]);

    available = true;
    await expect(publisher.publishPending()).resolves.toEqual({
      attempted: 1,
      published: 1,
      failed: 0,
    });
    expect(store.published).toEqual(['event-1']);
  });

  it('does not apply duplicate event deliveries', async () => {
    const processed = new Set<string>();
    const applied: string[] = [];
    const consumer = new IdempotentEventConsumer<Event>(
      {
        hasProcessed: async (id) => Promise.resolve(processed.has(id)),
        markProcessed: async (id) => {
          await Promise.resolve();
          processed.add(id);
        },
      },
      async (event) => {
        await Promise.resolve();
        applied.push(event.value);
      },
    );

    await expect(consumer.consume({ id: 'event-1', value: 'patch' })).resolves.toBe(true);
    await expect(consumer.consume({ id: 'event-1', value: 'patch' })).resolves.toBe(false);
    expect(applied).toEqual(['patch']);
  });
});

describe('ordered outbox delivery and work routing', () => {
  it('publishes same-game patches in state-version order and blocks later versions after a failure', async () => {
    const events = [
      { id: 'event-3', gameId: 'game-1', stateVersion: 3, value: 'third' },
      { id: 'event-1', gameId: 'game-1', stateVersion: 1, value: 'first' },
      { id: 'event-2', gameId: 'game-1', stateVersion: 2, value: 'second' },
      { id: 'event-a', gameId: 'game-2', stateVersion: 1, value: 'other-game' },
    ] as const;
    const store = new FakeOutboxStore(events);
    const published: string[] = [];
    const publisher = new OutboxPublisher(store, {
      publish: async (event) => {
        await Promise.resolve();
        published.push(event.id);
        if (event.id === 'event-1') throw new Error('broker unavailable');
      },
    });

    await expect(publisher.publishPending()).resolves.toEqual({
      attempted: 4,
      published: 1,
      failed: 1,
    });
    expect(published).toEqual(['event-1', 'event-a']);
    expect(store.published).toEqual(['event-a']);
    expect(store.failures).toEqual([{ id: 'event-1', error: 'broker unavailable' }]);
  });

  it('serializes concurrent duplicate deliveries and releases a failed claim for retry', async () => {
    const processed = new Set<string>();
    const claimed = new Set<string>();
    const applied: string[] = [];
    let releaseCount = 0;
    let failOnce = true;
    const consumer = new IdempotentEventConsumer<Event & { gameId: string }>(
      {
        hasProcessed: async (id) => {
          await Promise.resolve();
          return processed.has(id);
        },
        tryClaim: async (id) => {
          await Promise.resolve();
          claimed.add(id);
          return true;
        },
        markProcessed: async (id) => {
          await Promise.resolve();
          processed.add(id);
        },
        releaseClaim: async (id) => {
          await Promise.resolve();
          claimed.delete(id);
          releaseCount += 1;
        },
      },
      async (event) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('handler unavailable');
        }
        applied.push(event.value);
        await Promise.resolve();
      },
    );

    await expect(
      consumer.consume({ id: 'event-1', value: 'patch', gameId: 'game-1' }),
    ).rejects.toThrow('handler unavailable');
    await expect(
      Promise.all([
        consumer.consume({ id: 'event-1', value: 'patch', gameId: 'game-1' }),
        consumer.consume({ id: 'event-1', value: 'patch', gameId: 'game-1' }),
      ]),
    ).resolves.toEqual([true, true]);
    expect(applied).toEqual(['patch']);
    expect(releaseCount).toBe(1);
    expect(await consumer.consume({ id: 'event-1', value: 'patch', gameId: 'game-1' })).toBe(false);
  });

  it('routes notification, push, and snapshot work through one idempotent consumer', async () => {
    const processed = new Set<string>();
    const calls: string[] = [];
    const consumer = new OutboxWorkConsumer(
      {
        hasProcessed: async (id) => {
          await Promise.resolve();
          return processed.has(id);
        },
        markProcessed: async (id) => {
          await Promise.resolve();
          processed.add(id);
        },
      },
      {
        gamePatch: async () => {
          await Promise.resolve();
          calls.push('patch');
        },
        notification: async () => {
          await Promise.resolve();
          calls.push('notification');
        },
        push: async () => {
          await Promise.resolve();
          calls.push('push');
        },
        snapshotRequired: async () => {
          await Promise.resolve();
          calls.push('snapshot');
        },
      },
    );

    const base = { gameId: 'game-1' as never, stateVersion: 1 as never };
    await consumer.consume({
      id: 'patch',
      eventType: 'game.patch',
      ...base,
      payload: { changes: { squares: [] } },
    });
    await consumer.consume({
      id: 'notification',
      eventType: 'notification.work',
      ...base,
      payload: { kind: 'notification.work', notification: {} as never },
    });
    await consumer.consume({
      id: 'push',
      eventType: 'push.work',
      ...base,
      payload: {
        kind: 'push.work',
        recipientParticipantId: 'participant-1' as never,
        payload: {
          gameName: 'Game',
          requestingParticipant: 'Alex',
          taskText: 'Task',
          deepLink: 'https://app.example/game/game-1/notifications?request=req-1',
        },
      },
    });
    await consumer.consume({
      id: 'snapshot',
      eventType: 'snapshot.required',
      ...base,
      payload: {
        kind: 'snapshot.required',
        expectedStateVersion: 2 as never,
        reason: 'retention_miss',
      },
    });

    expect(calls).toEqual(['patch', 'notification', 'push', 'snapshot']);
  });
});
