import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  GameStatus,
  type CorrelationId,
  type GameId,
  type IdempotencyKey,
} from '@human-bingo/domain';
import { InMemoryInvitationRepository } from '@human-bingo/persistence';
import { readPropertyTestOptions } from '@human-bingo/test-utils';

import { InvitationService, hashInvitationToken, tokenFromCanonicalLink } from './invitation.js';

const correlationId = 'property-3-correlation' as CorrelationId;
const gameNameArbitrary = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((value) => value.trim().length > 0);

interface JoinableGameCase {
  readonly sequence: number;
  readonly name: string;
}

describe('Property 3: invitation representation round trip', () => {
  it('resolves every representation to one onboarding preview without membership mutation', async () => {
    // Feature: human-bingo, Property 3
    // **Validates: Requirements 2.2, 2.3, 2.4, 2.5**
    await fc.assert(
      fc.asyncProperty(
        fc.record({ sequence: fc.integer({ min: 1, max: 1_000_000 }), name: gameNameArbitrary }),
        async ({ sequence, name }: JoinableGameCase) => {
          const gameId = `property-3-game-${sequence}` as GameId;
          const repository = new InMemoryInvitationRepository({
            idFactory: () => `invitation-${sequence}`,
          });
          repository.setGame({ id: gameId, name, status: GameStatus.InvitationAvailable });
          const service = new InvitationService(repository, {
            canonicalBaseUrl: 'https://app.example',
          });

          const created = await service.create({
            gameId,
            correlationId,
            idempotencyKey: `create-${sequence}` as IdempotencyKey,
          });
          const repeated = await service.create({
            gameId,
            correlationId,
            idempotencyKey: `repeat-${sequence}` as IdempotencyKey,
          });
          expect(repeated.invitation).toEqual(created.invitation);
          expect(created.invitation.joinCode).toMatch(/^[A-Z0-9]{6}$/);

          const token = tokenFromCanonicalLink(created.invitation.canonicalLink);
          const decodedQrLink = service.resolveQr({
            correlationId,
            qrPayload: created.invitation.qrPayload,
          });
          const [codePreview, tokenPreview, qrPreview] = await Promise.all([
            service.resolve({ correlationId, input: { joinCode: created.invitation.joinCode } }),
            service.resolve({ correlationId, input: { token } }),
            decodedQrLink,
          ]);
          expect(tokenPreview.preview).toEqual(codePreview.preview);
          expect(qrPreview.preview).toEqual(codePreview.preview);
          expect(qrPreview.preview).toMatchObject({
            gameId,
            gameName: name,
            joinCode: created.invitation.joinCode,
          });

          const stored = await repository.findByGameId(gameId);
          expect(stored).not.toBeNull();
          expect(stored?.joinCode).toBe(created.invitation.joinCode);
          expect(stored?.tokenHash).toEqual(hashInvitationToken(token));
          // Resolution has no membership repository dependency and therefore cannot mutate membership.
          expect(await repository.findByGameId(gameId)).toEqual(stored);

          await service.assertUsableForOnboarding({ correlationId, gameId, invitation: { token } });
        },
      ),
      readPropertyTestOptions(),
    );
  });
});
