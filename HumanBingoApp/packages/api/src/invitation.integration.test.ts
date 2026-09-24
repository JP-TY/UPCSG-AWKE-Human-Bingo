import { describe, expect, it } from 'vitest';

import {
  GameStatus,
  HumanBingoError,
  type AddTaskEntryCommand,
  type CorrelationId,
  type CreateGameCommand,
  type GameId,
  type IdempotencyKey,
  type OpenGameCommand,
} from '@human-bingo/domain';
import {
  InMemoryGameConfigurationRepository,
  InMemoryInvitationRepository,
} from '@human-bingo/persistence';

import { GameConfigurationService } from './game-configuration.js';
import { InvitationService, tokenFromCanonicalLink } from './invitation.js';

const correlationId = 'invitation-integration' as CorrelationId;

const addRequiredTasks = async (
  service: GameConfigurationService,
  gameId: GameId,
): Promise<number> => {
  let version = 0;
  for (let index = 0; index < 25; index += 1) {
    const result = await service.addTaskEntry({
      gameId,
      text: `Integration task ${index + 1}`,
      correlationId,
      idempotencyKey: `task-${index + 1}` as IdempotencyKey,
      knownStateVersion: version as never,
    } satisfies AddTaskEntryCommand);
    version = Number(result.stateVersion);
  }
  return version;
};

describe('invitation/game lifecycle integration', () => {
  it('keeps representation resolution read-only and re-checks closure before onboarding commit', async () => {
    const configurationRepository = new InMemoryGameConfigurationRepository({
      idFactory: () => 'game-integration',
    });
    const configuration = new GameConfigurationService(configurationRepository, {
      idFactory: (() => {
        let sequence = 0;
        return () => `task-${++sequence}`;
      })(),
    });
    const created = await configuration.createGame(
      {
        name: 'Integration Bingo',
        correlationId,
        idempotencyKey: 'create-game' as IdempotencyKey,
      } satisfies CreateGameCommand,
      'host-1',
    );
    const gameId = created.game.id;
    const version = await addRequiredTasks(configuration, gameId);
    const opened = await configuration.openGame({
      gameId,
      correlationId,
      idempotencyKey: 'open-game' as IdempotencyKey,
      knownStateVersion: version as never,
    } satisfies OpenGameCommand);

    const invitationRepository = new InMemoryInvitationRepository();
    invitationRepository.setGame({
      id: gameId,
      name: opened.game.name,
      status: opened.game.status,
    });
    const invitations = new InvitationService(invitationRepository);
    const createdInvitation = await invitations.create({
      gameId,
      correlationId,
      idempotencyKey: 'create-invitation' as IdempotencyKey,
    });

    const membershipMutations = 0;
    const preview = await invitations.resolve({
      correlationId,
      input: { token: tokenFromCanonicalLink(createdInvitation.invitation.canonicalLink) },
    });
    expect(preview.preview.gameId).toBe(gameId);
    expect(membershipMutations).toBe(0);

    await invitations.assertUsableForOnboarding({
      correlationId,
      gameId,
      invitation: { joinCode: createdInvitation.invitation.joinCode },
    });
    expect(membershipMutations).toBe(0);

    const closed = await configuration.closeGame({
      gameId,
      correlationId,
      idempotencyKey: 'close-game' as IdempotencyKey,
      knownStateVersion: opened.stateVersion,
    });
    invitationRepository.setGame({ id: gameId, name: closed.game.name, status: GameStatus.Closed });
    await expect(
      invitations.assertUsableForOnboarding({
        correlationId,
        gameId,
        invitation: { joinCode: createdInvitation.invitation.joinCode },
      }),
    ).rejects.toBeInstanceOf(HumanBingoError);
    expect(membershipMutations).toBe(0);
  });
});
