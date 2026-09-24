import { describe, expect, it } from 'vitest';
import type { RealtimeEvent } from '@human-bingo/domain';
import {
  assertByteLength,
  assertParameterizedQuery,
  assertRequestBodySize,
  InMemoryRateLimiter,
  OriginPolicy,
  SecurityValidationError,
  validateInputLimits,
} from './security.js';
import { encodeBoundedRealtimeEvent, HeartbeatMonitor, reconnectDelay } from './realtime.js';

const event = (changes: Record<string, unknown> = {}): RealtimeEvent => ({
  type: 'game.patch',
  gameId: 'game-1' as never,
  stateVersion: 2 as never,
  previousStateVersion: 1 as never,
  eventId: 'event-1' as never,
  changes,
});

describe('resilience and security guards', () => {
  it('rejects oversized UTF-8 fields and request bodies before application work', () => {
    expect(() => assertByteLength('é'.repeat(3), 6, 'task')).not.toThrow();
    expect(() => assertByteLength('é'.repeat(3), 5, 'task')).toThrow(SecurityValidationError);
    expect(() => assertRequestBodySize(new Uint8Array(65), 64)).toThrow(SecurityValidationError);
    expect(() => validateInputLimits({ text: 'x'.repeat(501) })).toThrow(/text/);
  });

  it('allows only explicit credentialed origins and never emits wildcard CORS', () => {
    const policy = new OriginPolicy(['https://app.example']);
    expect(policy.allows('https://app.example')).toBe(true);
    expect(policy.allows('https://evil.example')).toBe(false);
    expect(policy.allows('https://app.example/')).toBe(false);
    expect(policy.headers('https://app.example')).toEqual({
      'access-control-allow-origin': 'https://app.example',
      'access-control-allow-credentials': 'true',
      vary: 'Origin',
    });
    expect(policy.headers('https://evil.example')).toBeNull();
    expect(() => new OriginPolicy(['*'])).toThrow(SecurityValidationError);
  });

  it('enforces a per-key rate limit and resets only after the window', () => {
    let now = 1_000;
    const limiter = new InMemoryRateLimiter({ limit: 2, windowMs: 1_000, now: () => now });
    expect(limiter.consume('ip:one')).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.consume('ip:one')).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume('ip:one')).toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterMs: 1_000,
    });
    expect(limiter.consume('ip:two').allowed).toBe(true);
    now += 1_000;
    expect(limiter.consume('ip:one')).toMatchObject({
      allowed: true,
      remaining: 1,
      retryAfterMs: 0,
    });
  });

  it('requires positional SQL parameters whenever values are supplied', () => {
    expect(() =>
      assertParameterizedQuery('SELECT * FROM games WHERE id = $1', ['game-1']),
    ).not.toThrow();
    expect(() => assertParameterizedQuery('SELECT * FROM games WHERE id = $1', [])).not.toThrow();
    expect(() =>
      assertParameterizedQuery("SELECT * FROM games WHERE id = 'game-1'", ['unused']),
    ).toThrow(SecurityValidationError);
    expect(() => assertParameterizedQuery('SELECT * FROM games WHERE id = $2', ['game-1'])).toThrow(
      SecurityValidationError,
    );
  });

  it('bounds realtime payloads and rejects secret-bearing fields', () => {
    const encoded = encodeBoundedRealtimeEvent(event({ squares: [{ squareIndex: 1 }] }), 200);
    expect(JSON.parse(encoded)).toMatchObject({ type: 'game.patch' });
    expect(() => encodeBoundedRealtimeEvent(event({ text: 'x'.repeat(500) }), 200)).toThrow(
      /maximum payload size/,
    );
    expect(() => encodeBoundedRealtimeEvent(event({ sessionToken: 'never-send' }), 2_000)).toThrow(
      /secret field/,
    );
  });

  it('uses capped exponential reconnect backoff with deterministic jitter', () => {
    expect(
      reconnectDelay(0, { baseDelayMs: 100, maxDelayMs: 500, jitterRatio: 0.2 }, () => 0.5),
    ).toBe(100);
    expect(
      reconnectDelay(3, { baseDelayMs: 100, maxDelayMs: 500, jitterRatio: 0.2 }, () => 1),
    ).toBe(500);
    expect(
      reconnectDelay(3, { baseDelayMs: 100, maxDelayMs: 500, jitterRatio: 0.2 }, () => 0),
    ).toBe(400);
  });

  it('marks a connection stale only after the configured missed-pong threshold', () => {
    const monitor = new HeartbeatMonitor(
      { intervalMs: 1_000, timeoutMs: 100, maxMissedPongs: 2 },
      0,
    );
    expect(monitor.check(1_100)).toBe('healthy');
    expect(monitor.check(2_099)).toBe('healthy');
    expect(monitor.check(2_100)).toBe('stale');
    monitor.receivePong(2_100);
    expect(monitor.check(3_200)).toBe('healthy');
    expect(monitor.missedPongs).toBe(0);
  });
});
