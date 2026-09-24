import { describe, expect, it } from 'vitest';

import {
  createVerificationPushPayload,
  isSafeVerificationPushPayload,
  type GameId,
  type VerificationRequestId,
} from './index.js';

describe('verification push payloads', () => {
  const input = {
    appOrigin: 'https://app.example',
    gameId: 'game-1' as GameId,
    verificationRequestId: 'request-1' as VerificationRequestId,
    gameName: 'Team Bingo',
    requestingParticipant: 'Alex',
    taskText: 'has visited three countries',
  };

  it('creates an origin-scoped deep link with only safe identifiers', () => {
    const payload = createVerificationPushPayload(input);

    expect(payload).toEqual({
      gameName: 'Team Bingo',
      requestingParticipant: 'Alex',
      taskText: 'has visited three countries',
      deepLink: 'https://app.example/game/game-1/notifications?request=request-1',
    });
    expect(payload.deepLink).not.toContain('token');
    expect(payload.deepLink).not.toContain('session');
    expect(isSafeVerificationPushPayload(payload, 'https://app.example')).toBe(true);
  });

  it('rejects unsafe origins and deep-link routes', () => {
    expect(() =>
      createVerificationPushPayload({ ...input, appOrigin: 'http://evil.example' }),
    ).toThrow();
    expect(
      isSafeVerificationPushPayload(
        {
          ...createVerificationPushPayload(input),
          deepLink: 'https://evil.example/game/game-1/notifications?request=request-1',
        },
        'https://app.example',
      ),
    ).toBe(false);
    expect(
      isSafeVerificationPushPayload(
        { ...createVerificationPushPayload(input), deepLink: 'https://app.example/invite/secret' },
        'https://app.example',
      ),
    ).toBe(false);
  });
});
