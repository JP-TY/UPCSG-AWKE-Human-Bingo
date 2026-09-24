import { describe, expect, it } from 'vitest';

import { DomainErrorCode, HumanBingoError, type CorrelationId } from './contracts.js';

describe('HumanBingoError', () => {
  it('serializes stable error fields and safe metadata', () => {
    const error = new HumanBingoError({
      code: DomainErrorCode.StaleState,
      message: 'The game state has changed; refresh and retry.',
      correlationId: 'correlation-1' as CorrelationId,
      retryable: true,
      httpStatus: 409,
      metadata: { currentStateVersion: 12 },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('HumanBingoError');
    expect(error.toDto()).toEqual({
      code: DomainErrorCode.StaleState,
      message: 'The game state has changed; refresh and retry.',
      correlationId: 'correlation-1',
      retryable: true,
      httpStatus: 409,
      metadata: { currentStateVersion: 12 },
    });
  });

  it('omits optional fields when they are not supplied', () => {
    const error = new HumanBingoError({
      code: DomainErrorCode.GameClosed,
      message: 'The game is closed.',
      correlationId: 'correlation-2' as CorrelationId,
      retryable: false,
      httpStatus: 409,
    });

    expect(error.toDto()).toEqual({
      code: DomainErrorCode.GameClosed,
      message: 'The game is closed.',
      correlationId: 'correlation-2',
      retryable: false,
      httpStatus: 409,
    });
  });
});
