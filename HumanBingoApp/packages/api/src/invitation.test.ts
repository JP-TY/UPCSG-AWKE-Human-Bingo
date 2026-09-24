import { describe, expect, it } from 'vitest';

import {
  DomainErrorCode,
  GameStatus,
  type CorrelationId,
  type GameId,
  type IdempotencyKey,
} from '@human-bingo/domain';
import { InMemoryInvitationRepository } from '@human-bingo/persistence';

import {
  decodeQrPayload,
  encodeQrPayload,
  hashInvitationToken,
  InvitationService,
  tokenFromCanonicalLink,
} from './invitation.js';

const correlationId = 'invitation-test' as CorrelationId;
const command = (gameId: GameId) => ({
  gameId,
  correlationId,
  idempotencyKey: 'create-invitation' as IdempotencyKey,
});

const createGame = (
  repository: InMemoryInvitationRepository,
  gameId: GameId = 'game-1' as GameId,
  status: GameStatus = GameStatus.InvitationAvailable,
): void => {
  repository.setGame({ id: gameId, name: 'Test Bingo', status });
};

const expectError = async (
  action: () => Promise<unknown>,
  code: DomainErrorCode,
): Promise<void> => {
  await expect(action()).rejects.toMatchObject({ code });
};

describe('InvitationService', () => {
  it('creates one secure six-character code and canonical QR representation per game', async () => {
    const repository = new InMemoryInvitationRepository({ idFactory: () => 'invitation-1' });
    createGame(repository);
    const service = new InvitationService(repository, {
      canonicalBaseUrl: 'https://bingo.example',
      randomBytes: () => new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1)),
      randomInt: (() => {
        let index = 0;
        return () => index++ % 36;
      })(),
    });

    const created = await service.create(command('game-1' as GameId));
    const repeated = await service.create(command('game-1' as GameId));
    expect(created.invitation).toEqual(repeated.invitation);
    expect(created.invitation.joinCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(created.invitation.canonicalLink).toMatch(
      /^https:\/\/bingo\.example\/invite\/[A-Za-z0-9_-]+$/,
    );
    expect(decodeQrPayload(created.invitation.qrPayload)).toBe(created.invitation.canonicalLink);

    const token = tokenFromCanonicalLink(created.invitation.canonicalLink);
    const stored = await repository.findByGameId('game-1' as GameId);
    expect(stored).not.toBeNull();
    expect(stored?.tokenHash).toEqual(hashInvitationToken(token));
    expect(Buffer.from(stored?.tokenHash ?? []).toString('utf8')).not.toContain(token);
  });

  it('resolves code, token, and QR to the same preview without creating membership', async () => {
    const repository = new InMemoryInvitationRepository();
    createGame(repository);
    const service = new InvitationService(repository);
    const created = await service.create(command('game-1' as GameId));
    const token = tokenFromCanonicalLink(created.invitation.canonicalLink);

    const byCode = await service.resolve({
      correlationId,
      input: { joinCode: created.invitation.joinCode },
    });
    const byToken = await service.resolve({ correlationId, input: { token } });
    const byQr = await service.resolveQr({
      correlationId,
      qrPayload: created.invitation.qrPayload,
    });
    expect(byCode.preview).toEqual(byToken.preview);
    expect(byToken.preview).toEqual(byQr.preview);
    expect(byCode.preview).toMatchObject({
      gameId: 'game-1',
      gameName: 'Test Bingo',
      joinCode: created.invitation.joinCode,
    });
  });

  it('rejects expired and revoked invitations, then invalidates them again after closure', async () => {
    const repository = new InMemoryInvitationRepository();
    createGame(repository);
    let now = new Date('2025-01-01T00:00:00.000Z');
    const service = new InvitationService(repository, {
      now: () => now,
      expiresAt: new Date('2025-01-01T00:01:00.000Z'),
    });
    const created = await service.create(command('game-1' as GameId));
    const token = tokenFromCanonicalLink(created.invitation.canonicalLink);

    await service.assertUsableForOnboarding({
      correlationId,
      gameId: 'game-1' as GameId,
      invitation: { token },
    });
    now = new Date('2025-01-01T00:01:00.000Z');
    await expectError(
      () => service.resolve({ correlationId, input: { token } }),
      DomainErrorCode.InvitationInvalid,
    );

    now = new Date('2025-01-01T00:00:30.000Z');
    repository.revoke('game-1' as GameId, now);
    await expectError(
      () => service.resolve({ correlationId, input: { joinCode: created.invitation.joinCode } }),
      DomainErrorCode.InvitationInvalid,
    );

    repository.setGame({ id: 'game-1' as GameId, name: 'Test Bingo', status: GameStatus.Closed });
    await expectError(
      () =>
        service.assertUsableForOnboarding({
          correlationId,
          gameId: 'game-1' as GameId,
          invitation: { token },
        }),
      DomainErrorCode.InvitationClosed,
    );
  });

  it('keeps malformed and cross-game inputs outside the resolution boundary', async () => {
    const repository = new InMemoryInvitationRepository();
    createGame(repository, 'game-1' as GameId);
    createGame(repository, 'game-2' as GameId);
    const service = new InvitationService(repository);
    const created = await service.create(command('game-1' as GameId));

    await expectError(
      () => service.resolve({ correlationId, input: { joinCode: 'bad' as never } }),
      DomainErrorCode.InvitationInvalid,
    );
    await expectError(
      () =>
        service.assertUsableForOnboarding({
          correlationId,
          gameId: 'game-2' as GameId,
          invitation: { joinCode: created.invitation.joinCode },
        }),
      DomainErrorCode.InvitationInvalid,
    );
    expect(encodeQrPayload(created.invitation.canonicalLink)).toBe(created.invitation.qrPayload);
  });

  it('prefers a per-request canonical base URL for created representations', async () => {
    const repository = new InMemoryInvitationRepository();
    createGame(repository);
    const service = new InvitationService(repository);
    const created = await service.create(command('game-1' as GameId), {
      canonicalBaseUrl: 'http://localhost:5173',
    });
    const repeated = await service.create(command('game-1' as GameId), {
      canonicalBaseUrl: 'http://localhost:5173',
    });
    expect(created.invitation.canonicalLink).toBe(repeated.invitation.canonicalLink);
    expect(created.invitation.canonicalLink).toMatch(
      /^http:\/\/localhost:5173\/invite\/[A-Za-z0-9_-]+$/,
    );
    expect(decodeQrPayload(created.invitation.qrPayload)).toBe(created.invitation.canonicalLink);
  });
});
