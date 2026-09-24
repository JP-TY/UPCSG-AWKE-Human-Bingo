import { describe, expect, it } from 'vitest';

import {
  DomainErrorCode,
  HumanBingoError,
  type CorrelationId,
  type CreateGameCommand,
  type IdempotencyKey,
  type StateVersion,
} from '@human-bingo/domain';
import { InMemoryGameConfigurationRepository } from '@human-bingo/persistence';

import { GameConfigurationService } from './game-configuration.js';
import {
  HealthService,
  InMemoryAuditSink,
  createObservability,
  createStructuredLogger,
  observeCommand,
  observeRequest,
  recordAuthorizationDenial,
  recordEventDelivery,
  recordPushFailure,
  recordSynchronization,
  reportSafeError,
  toSafeErrorReport,
} from './observability.js';
import type { InMemoryMetrics } from './observability.js';

const correlationId = 'observability-correlation' as CorrelationId;
const idempotencyKey = 'observability-command' as IdempotencyKey;

function createTestObservability(): ReturnType<typeof createObservability> {
  return createObservability({ now: () => new Date('2025-01-01T00:00:01.000Z') });
}

describe('observability', () => {
  it('writes structured JSON-safe records and redacts credentials and private payloads', () => {
    const records: unknown[] = [];
    const logger = createStructuredLogger(
      (record) => records.push(record),
      () => new Date('2025-01-01T00:00:00.000Z'),
    );

    logger.info('request.completed', {
      correlationId: 'correlation-1',
      metadata: {
        sessionCookie: 'secret-cookie',
        playerCode: 'PLAYER-1',
        route: '/api/games/opaque-id',
      },
    });

    expect(records[0]).toEqual({
      timestamp: '2025-01-01T00:00:00.000Z',
      level: 'info',
      event: 'request.completed',
      correlationId: 'correlation-1',
      metadata: {
        sessionCookie: '[REDACTED]',
        playerCode: '[REDACTED]',
        route: '/api/games/opaque-id',
      },
    });
  });

  it('tracks service commands and stale-command failures', async () => {
    const observability = createTestObservability();
    const repository = new InMemoryGameConfigurationRepository({ now: observability.now });
    const service = new GameConfigurationService(repository, { observability: observability });
    const createCommand: CreateGameCommand = {
      name: 'Metrics game',
      correlationId,
      idempotencyKey,
    };
    const created = await service.createGame(createCommand, 'host-1');

    await expect(
      service.renameGame({
        gameId: created.game.id,
        name: 'stale',
        correlationId,
        idempotencyKey: 'stale-command' as IdempotencyKey,
        knownStateVersion: 99 as StateVersion,
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.StaleState });

    const snapshot = (observability.metrics as InMemoryMetrics).snapshot();
    expect(snapshot.counters['human_bingo_command_started_total{command=create_game}']).toBe(1);
    expect(snapshot.counters['human_bingo_command_succeeded_total{command=create_game}']).toBe(1);
    expect(snapshot.counters['human_bingo_stale_command_total{command=rename_game}']).toBe(1);
  });

  it('tracks requests, synchronization, event delivery, and push failures', async () => {
    const observability = createTestObservability();
    await observeRequest(
      observability,
      {
        requestId: 'request-1',
        correlationId: 'correlation-1',
        command: 'snapshot',
        method: 'GET',
        route: '/api/games/:id/snapshot',
      },
      () => Promise.resolve('ok'),
    );
    recordSynchronization(observability, { gameId: 'game-1', durationMs: 12, outcome: 'success' });
    recordEventDelivery(observability, {
      gameId: 'game-1',
      eventId: 'event-1',
      durationMs: 8,
      outcome: 'delivered',
    });
    recordPushFailure(observability, { gameId: 'game-1', reason: 'provider_unavailable' });

    const snapshot = (observability.metrics as InMemoryMetrics).snapshot();
    expect(
      snapshot.counters[
        'human_bingo_request_succeeded_total{method=GET,route=/api/games/:id/snapshot}'
      ],
    ).toBe(1);
    expect(snapshot.counters['human_bingo_synchronization_total{outcome=success}']).toBe(1);
    expect(
      snapshot.observations['human_bingo_event_delivery_duration_ms{outcome=delivered}'],
    ).toEqual([8]);
    expect(snapshot.counters['human_bingo_push_failure_total{reason=provider_unavailable}']).toBe(
      1,
    );
  });

  it('records authorization denials as opaque audit events', () => {
    const audit = new InMemoryAuditSink();
    const observability = createObservability({
      audit,
      now: () => new Date('2025-01-01T00:00:00.000Z'),
    });
    recordAuthorizationDenial(observability, {
      correlationId: 'correlation-1',
      gameId: 'game-1',
      resource: 'membership',
      reason: 'UNAUTHORIZED',
    });

    expect(audit.events()).toEqual([
      {
        event: 'authorization.denied',
        timestamp: '2025-01-01T00:00:00.000Z',
        correlationId: 'correlation-1',
        gameId: 'game-1',
        resource: 'membership',
        reason: 'UNAUTHORIZED',
      },
    ]);
  });

  it('returns safe internal error reports without stack or raw error details', () => {
    const unknownError = new Error('database password=do-not-expose');
    expect(toSafeErrorReport(unknownError, 'correlation-1')).toEqual({
      code: 'INTERNAL_ERROR',
      correlationId: 'correlation-1',
      message: 'An unexpected error occurred. Please try again.',
      retryable: true,
      httpStatus: 500,
    });

    const domainError = new HumanBingoError({
      code: DomainErrorCode.GameClosed,
      message: 'The game is closed.',
      correlationId,
      retryable: false,
      httpStatus: 409,
    });
    expect(reportSafeError(createTestObservability(), domainError)).toMatchObject({
      code: DomainErrorCode.GameClosed,
      correlationId,
      httpStatus: 409,
    });
  });

  it('reports readiness failures while keeping liveness healthy', async () => {
    const health = new HealthService(
      [
        { name: 'database', check: () => Promise.resolve() },
        { name: 'broker', check: () => Promise.reject(new Error('broker details stay private')) },
      ],
      () => new Date('2025-01-01T00:00:00.000Z'),
    );

    expect(health.liveness()).toEqual({
      status: 'ok',
      checks: [],
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    await expect(health.readiness()).resolves.toMatchObject({
      status: 'failed',
      checks: [
        { name: 'database', status: 'ok' },
        { name: 'broker', status: 'failed' },
      ],
    });
  });

  it('supports direct command observation for future HTTP routes', async () => {
    const observability = createTestObservability();
    await expect(
      observeCommand(
        observability,
        { correlationId: 'correlation-1', command: 'test_command', gameId: 'game-1' },
        () => Promise.resolve(42),
      ),
    ).resolves.toBe(42);
    expect(
      (observability.metrics as InMemoryMetrics).snapshot().counters[
        'human_bingo_command_succeeded_total{command=test_command}'
      ],
    ).toBe(1);
  });
});
