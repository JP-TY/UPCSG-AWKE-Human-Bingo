import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthorizationPrincipal } from './access/authorization.js';
import type { GameId, StateVersion } from '@human-bingo/domain';
import type { OutboxEventRecord } from '@human-bingo/persistence';
import { RealtimeGateway, RealtimePayloadError, type RealtimeSocket } from './realtime.js';

const gameId = 'game-1' as GameId;
const principal: AuthorizationPrincipal = {
  accountOrGuestIdentity: 'membership:membership-1',
  membershipId: 'membership-1' as never,
  participantId: 'participant-1' as never,
};

class FakeSocket implements RealtimeSocket {
  readonly messages: string[] = [];
  readonly closes: Array<{ readonly code?: number; readonly reason?: string }> = [];
  #messageListener: ((data: string | Uint8Array | ArrayBuffer) => void) | undefined;
  #closeListener: (() => void) | undefined;

  public send(data: string): void {
    this.messages.push(data);
  }

  public close(code?: number, reason?: string): void {
    this.closes.push({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  public onMessage(listener: (data: string | Uint8Array | ArrayBuffer) => void): void {
    this.#messageListener = listener;
  }

  public onClose(listener: () => void): void {
    this.#closeListener = listener;
  }

  public receive(data: string | Uint8Array | ArrayBuffer): void {
    this.#messageListener?.(data);
  }

  public remoteClose(): void {
    this.#closeListener?.();
  }
}

const outbox = (
  version: number,
  eventId: string,
  changes: Record<string, unknown> = { squares: [{ squareIndex: 0, status: 'verified' }] },
): OutboxEventRecord => ({
  id: eventId as never,
  gameId,
  stateVersion: BigInt(version),
  eventType: 'verification.changed',
  payload: { changes },
  createdAt: new Date(0),
  publishedAt: null,
  attemptCount: 0,
  nextAttemptAt: null,
  lastError: null,
});

const parseMessage = (message: string): Readonly<Record<string, unknown>> => {
  const parsed = JSON.parse(message) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object');
  }
  return parsed as Readonly<Record<string, unknown>>;
};

const createGateway = (options: ConstructorParameters<typeof RealtimeGateway>[2] = {}) => {
  const authorize = vi.fn(
    (input: { readonly gameId: GameId; readonly principal: AuthorizationPrincipal }) =>
      Promise.resolve({
        gameId: input.gameId,
        principal: input.principal,
        participantId: principal.participantId!,
        membership: {} as never,
      }),
  );
  const authenticate = vi.fn((credential: string) => {
    void credential;
    return Promise.resolve(principal);
  });
  const gateway = new RealtimeGateway({ authorize }, { authenticate }, options);
  return { gateway, authorize, authenticate };
};

describe('RealtimeGateway', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('authenticates and authorizes a game channel before registering a client', async () => {
    const { gateway, authorize, authenticate } = createGateway();
    const socket = new FakeSocket();

    const connection = await gateway.accept(socket, {
      gameId,
      sessionCredential: 'session-credential',
      lastKnownStateVersion: 0 as StateVersion,
    });

    expect(authenticate).toHaveBeenCalledWith('session-credential');
    expect(authorize).toHaveBeenCalledWith({ gameId, principal });
    expect(connection.participantId).toBe('participant-1');
    connection.close();
  });

  it('emits ordered patches once and ignores duplicate event deliveries', async () => {
    const { gateway } = createGateway();
    const socket = new FakeSocket();
    const connection = await gateway.accept(socket, {
      gameId,
      sessionCredential: 'session-credential',
      lastKnownStateVersion: 0 as StateVersion,
    });

    await expect(gateway.publish(outbox(1, 'event-1'))).resolves.toBe(true);
    await expect(gateway.publish(outbox(2, 'event-2'))).resolves.toBe(true);
    await expect(gateway.publish(outbox(2, 'event-2'))).resolves.toBe(false);
    expect(socket.messages.map(parseMessage)).toEqual([
      expect.objectContaining({ type: 'game.patch', stateVersion: 1, eventId: 'event-1' }),
      expect.objectContaining({ type: 'game.patch', stateVersion: 2, eventId: 'event-2' }),
    ]);
    connection.close();
  });

  it('requests a snapshot for gaps and resumes ordered delivery after synchronization', async () => {
    const { gateway } = createGateway();
    const firstSocket = new FakeSocket();
    const first = await gateway.accept(firstSocket, {
      gameId,
      sessionCredential: 'session-credential',
      lastKnownStateVersion: 0 as StateVersion,
    });

    await gateway.publish(outbox(2, 'event-2'));
    expect(parseMessage(firstSocket.messages[0]!)).toEqual({
      type: 'snapshot_required',
      gameId,
      expectedStateVersion: 2,
      reason: 'retention_miss',
    });
    await gateway.publish(outbox(3, 'event-3'));
    expect(firstSocket.messages).toHaveLength(1);

    first.markSynchronized(3 as StateVersion);
    await gateway.publish(outbox(4, 'event-4'));
    expect(parseMessage(firstSocket.messages[1]!)).toEqual(
      expect.objectContaining({ type: 'game.patch', stateVersion: 4, eventId: 'event-4' }),
    );
    first.close();
  });

  it('accepts a client snapshot acknowledgement and resumes delivery', async () => {
    const { gateway } = createGateway();
    const socket = new FakeSocket();
    await gateway.accept(socket, {
      gameId,
      sessionCredential: 'session-credential',
      lastKnownStateVersion: 0 as StateVersion,
    });

    await gateway.publish(outbox(2, 'event-2'));
    socket.receive(JSON.stringify({ type: 'synchronized', stateVersion: 2 }));
    await gateway.publish(outbox(3, 'event-3'));

    expect(parseMessage(socket.messages.at(-1)!)).toEqual(
      expect.objectContaining({ type: 'game.patch', stateVersion: 3, eventId: 'event-3' }),
    );
  });

  it('seeds a fresh channel from the published outbox version so matching clients stay connected', async () => {
    const { gateway } = createGateway({
      seedVersion: vi.fn(() => Promise.resolve(7 as StateVersion)),
    });
    const socket = new FakeSocket();
    const connection = await gateway.accept(socket, {
      gameId,
      sessionCredential: 'session-credential',
      lastKnownStateVersion: 7 as StateVersion,
    });

    expect(socket.messages).toHaveLength(0);
    await gateway.publish(outbox(8, 'event-8'));
    expect(parseMessage(socket.messages[0]!)).toEqual(
      expect.objectContaining({ type: 'game.patch', stateVersion: 8, eventId: 'event-8' }),
    );
    connection.close();
  });

  it('raises the channel version when a client acknowledges a newer snapshot instead of looping', async () => {
    const { gateway } = createGateway();
    const socket = new FakeSocket();
    const connection = await gateway.accept(socket, {
      gameId,
      sessionCredential: 'session-credential',
      lastKnownStateVersion: 0 as StateVersion,
    });

    await gateway.publish(outbox(5, 'event-5'));
    expect(parseMessage(socket.messages[0]!)).toEqual({
      type: 'snapshot_required',
      gameId,
      expectedStateVersion: 5,
      reason: 'retention_miss',
    });

    connection.markSynchronized(5 as StateVersion);
    expect(socket.messages).toHaveLength(1);
    await gateway.publish(outbox(6, 'event-6'));
    expect(parseMessage(socket.messages[1]!)).toEqual(
      expect.objectContaining({ type: 'game.patch', stateVersion: 6, eventId: 'event-6' }),
    );
    connection.close();
  });

  it('replays retained events and falls back to snapshot when retention has been lost', async () => {
    const { gateway } = createGateway({ retainedEvents: 2 });
    await gateway.publish(outbox(1, 'event-1'));
    await gateway.publish(outbox(2, 'event-2'));
    await gateway.publish(outbox(3, 'event-3'));

    const replaySocket = new FakeSocket();
    const replay = await gateway.accept(replaySocket, {
      gameId,
      sessionCredential: 'session-credential',
      lastKnownStateVersion: 1 as StateVersion,
    });
    expect(replaySocket.messages.map((message) => parseMessage(message).stateVersion)).toEqual([
      2, 3,
    ]);

    const snapshotSocket = new FakeSocket();
    const snapshot = await gateway.accept(snapshotSocket, {
      gameId,
      sessionCredential: 'session-credential',
      lastKnownStateVersion: 0 as StateVersion,
    });
    expect(parseMessage(snapshotSocket.messages[0]!)).toEqual({
      type: 'snapshot_required',
      gameId,
      expectedStateVersion: 3,
      reason: 'retention_miss',
    });
    replay.close();
    snapshot.close();
  });

  it('rejects unauthorized handshakes and client-published game events', async () => {
    const { gateway } = createGateway();
    const socket = new FakeSocket();
    const connection = await gateway.accept(socket, {
      gameId,
      sessionCredential: 'session-credential',
      lastKnownStateVersion: 0 as StateVersion,
    });

    socket.receive(JSON.stringify({ type: 'game.patch', gameId, stateVersion: 99, changes: {} }));
    expect(socket.closes).toContainEqual({ code: 1008, reason: 'Invalid realtime message' });

    connection.close();
    const unauthorized = new RealtimeGateway(
      { authorize: vi.fn(() => Promise.reject(new Error('forbidden'))) },
      { authenticate: vi.fn(() => Promise.resolve(principal)) },
    );
    await expect(
      unauthorized.accept(new FakeSocket(), {
        gameId,
        sessionCredential: 'session-credential',
      }),
    ).rejects.toThrow('forbidden');
  });

  it('sends heartbeat pings and closes stale connections', async () => {
    vi.useFakeTimers();
    const { gateway } = createGateway({
      heartbeat: { intervalMs: 10, timeoutMs: 1, maxMissedPongs: 1 },
    });
    const socket = new FakeSocket();
    const connection = await gateway.accept(socket, {
      gameId,
      sessionCredential: 'session-credential',
      lastKnownStateVersion: 0 as StateVersion,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(parseMessage(socket.messages[0]!)).toEqual({ type: 'ping' });
    await vi.advanceTimersByTimeAsync(10);
    expect(socket.closes).toContainEqual({ code: 4000, reason: 'Heartbeat timeout' });
    connection.close();
  });

  it('does not emit an event that exceeds the configured payload bound', async () => {
    const { gateway } = createGateway({ maxEventBytes: 256 });
    const socket = new FakeSocket();
    const connection = await gateway.accept(socket, {
      gameId,
      sessionCredential: 'session-credential',
      lastKnownStateVersion: 0 as StateVersion,
    });

    await expect(
      gateway.publish(outbox(1, 'event-large', { squares: [{ taskText: 'x'.repeat(500) }] })),
    ).rejects.toThrow(RealtimePayloadError);
    expect(socket.messages).toHaveLength(0);
    connection.close();
  });
});
