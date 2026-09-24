import type { GameId } from '@human-bingo/domain';
import { OutboxEventRepository } from './repositories.js';
import type { SqlTransaction } from './transaction.js';

const outbox = new OutboxEventRepository();

/**
 * Publishes a game-scoped invalidation rather than member-specific records.
 * Each subscriber follows the event with its own authorized snapshot request.
 */
export function appendGamePatchInvalidation(
  transaction: SqlTransaction,
  gameId: GameId,
  stateVersion: bigint,
): Promise<void> {
  return outbox
    .append(transaction, {
      gameId,
      stateVersion,
      eventType: 'game.patch',
      payload: { changes: {} },
    })
    .then(() => undefined);
}
