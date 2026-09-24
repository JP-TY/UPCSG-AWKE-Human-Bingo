import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameId, StateVersion } from '@human-bingo/domain';
import {
  RealtimeGameSocket,
  type RealtimeSocketLike,
} from './realtime-client.js';

class FakeSocket implements RealtimeSocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly send = vi.fn();
  readonly close = vi.fn();

  public open(): void {
    this.onopen?.({});
  }

  public receive(data: unknown): void {
    this.onmessage?.({ data });
  }

  public disconnect(): void {
    this.onclose?.({});
  }
}

describe('RealtimeGameSocket', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers heartbeats and forwards game events', () => {
    const socket = new FakeSocket();
    const events: unknown[] = [];
    const socketFactory = vi.fn(() => socket);
    const client = new RealtimeGameSocket({
      wsUrl: 'wss://example.test/ws',
      gameId: 'game-a' as GameId,
      initialStateVersion: 7 as StateVersion,
      socketFactory,
      onEvent: (event) => events.push(event),
    });

    client.connect();
    socket.open();
    socket.receive('{"type":"ping"}');
    socket.receive('{"type":"game.patch","gameId":"game-a","stateVersion":1}');
    client.acknowledgeStateVersion(8 as StateVersion);

    expect(socket.send).toHaveBeenCalledWith('{"type":"pong"}');
    expect(socket.send).toHaveBeenCalledWith('{"type":"synchronized","stateVersion":8}');
    expect(socketFactory).toHaveBeenCalledWith(
      'wss://example.test/ws?gameId=game-a&lastKnownStateVersion=7',
    );
    expect(events).toHaveLength(1);
    expect(client.status).toBe('connected');
  });

  it('reconnects after an unexpected close and stops reconnecting when closed', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const socketFactory = vi.fn(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const client = new RealtimeGameSocket({
      wsUrl: 'wss://example.test/ws',
      gameId: 'game-a' as GameId,
      socketFactory,
      onEvent: () => undefined,
      random: () => 0.5,
    });

    client.connect();
    sockets[0]?.disconnect();
    vi.advanceTimersByTime(250);

    expect(socketFactory).toHaveBeenCalledTimes(2);
    client.close();
    sockets[1]?.disconnect();
    vi.advanceTimersByTime(30_000);
    expect(socketFactory).toHaveBeenCalledTimes(2);
    expect(client.status).toBe('closed');
  });
});
