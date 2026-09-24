import type {
  CompletionRecord,
  GameId,
  GameRecord,
  GridRecord,
  MembershipRecord,
  NotificationRecord,
  ParticipantId,
  PlayerProfileRecord,
  SquareRecord,
  TaskEntryRecord,
  VerificationRequestRecord,
} from './models.js';
import { VerificationGameNotFoundError } from './verification.js';
import type { VerificationRepository, VerificationState } from './verification.js';
import { appendGamePatchInvalidation } from './realtime-outbox.js';
import { withTransaction, type SqlClient, type SqlTransaction } from './transaction.js';

interface SqlGameRow {
  readonly id: string;
  readonly host_account_id: string;
  readonly name: string;
  readonly status: GameRecord['status'];
  readonly task_bag_locked_at: Date | string | null;
  readonly closed_at: Date | string | null;
  readonly state_version: string | number | bigint;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface SqlTaskRow {
  readonly id: string;
  readonly game_id: string;
  readonly display_text: string;
  readonly normalized_text: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly removed_at: Date | string | null;
}

interface SqlParticipantRow {
  readonly id: string;
  readonly game_id: string;
  readonly created_at: Date | string;
  readonly left_at: Date | string | null;
}

interface SqlMembershipRow {
  readonly id: string;
  readonly game_id: string;
  readonly participant_id: string;
  readonly identity_key: string;
  readonly browser_session_id: string | null;
  readonly resumable_credential_hash: Uint8Array;
  readonly created_at: Date | string;
  readonly last_seen_at: Date | string;
}

interface SqlProfileRow {
  readonly id: string;
  readonly game_id: string;
  readonly participant_id: string;
  readonly display_name: string | null;
  readonly player_code: string;
  readonly created_at: Date | string;
}

interface SqlGridRow {
  readonly id: string;
  readonly game_id: string;
  readonly participant_id: string;
  readonly task_bag_version: string | number | bigint;
  readonly state_version: string | number | bigint;
  readonly created_at: Date | string;
}

interface SqlSquareRow {
  readonly grid_id: string;
  readonly game_id: string;
  readonly square_index: number;
  readonly task_entry_id: string;
  readonly status: SquareRecord['status'];
  readonly stamp_index: number | null;
  readonly updated_at: Date | string;
}

interface SqlRequestRow {
  readonly id: string;
  readonly game_id: string;
  readonly grid_id: string;
  readonly square_index: number;
  readonly requesting_participant_id: string;
  readonly identified_participant_id: string;
  readonly status: VerificationRequestRecord['status'];
  readonly created_at: Date | string;
  readonly resolved_at: Date | string | null;
  readonly outcome_actor_id: string | null;
  readonly client_command_id: string;
}

interface SqlNotificationRow {
  readonly id: string;
  readonly game_id: string;
  readonly recipient_participant_id: string;
  readonly verification_request_id: string;
  readonly kind: string;
  readonly status: NotificationRecord['status'];
  readonly created_at: Date | string;
  readonly resolved_at: Date | string | null;
}

interface SqlCompletionRow {
  readonly id: string;
  readonly game_id: string;
  readonly participant_id: string;
  readonly category: CompletionRecord['category'];
  readonly completion_key: string;
  readonly completed_at: Date | string;
  readonly created_at: Date | string;
}

interface SqlIdempotencyRow {
  readonly scope_key: string;
  readonly idempotency_key: string;
  readonly command_type: string;
  readonly state_version: string | number | bigint | null;
  readonly result_json: unknown;
}

const asDate = (value: Date | string): Date => new Date(value);
const asNullableDate = (value: Date | string | null): Date | null =>
  value === null ? null : asDate(value);
const asBigInt = (value: string | number | bigint): bigint =>
  typeof value === 'bigint' ? value : BigInt(value);

async function loadState(
  transaction: SqlTransaction,
  gameId: GameId,
  lock = true,
): Promise<VerificationState> {
  const lockClause = lock ? ' FOR UPDATE' : '';
  const gameResult = await transaction.query<SqlGameRow>(
    `SELECT id, host_account_id, name, status, task_bag_locked_at, closed_at,
            state_version, created_at, updated_at
       FROM games WHERE id = $1${lockClause}`,
    [gameId],
  );
  const gameRow = gameResult.rows[0];
  if (gameRow === undefined) throw new VerificationGameNotFoundError(gameId);

  const [
    taskResult,
    participantResult,
    membershipResult,
    profileResult,
    gridResult,
    squareResult,
    requestResult,
    notificationResult,
    completionResult,
    idempotencyResult,
  ] = await Promise.all([
    transaction.query<SqlTaskRow>(
      `SELECT id, game_id, display_text, normalized_text, created_at, updated_at, removed_at
         FROM task_entries WHERE game_id = $1 ORDER BY created_at, id`,
      [gameId],
    ),
    transaction.query<SqlParticipantRow>(
      `SELECT id, game_id, created_at, left_at FROM participants WHERE game_id = $1`,
      [gameId],
    ),
    transaction.query<SqlMembershipRow>(
      `SELECT id, game_id, participant_id, identity_key, browser_session_id,
              resumable_credential_hash, created_at, last_seen_at
         FROM memberships WHERE game_id = $1`,
      [gameId],
    ),
    transaction.query<SqlProfileRow>(
      `SELECT id, game_id, participant_id, display_name, player_code, created_at
         FROM player_profiles WHERE game_id = $1`,
      [gameId],
    ),
    transaction.query<SqlGridRow>(
      `SELECT id, game_id, participant_id, task_bag_version, state_version, created_at
         FROM grids WHERE game_id = $1`,
      [gameId],
    ),
    transaction.query<SqlSquareRow>(
      `SELECT grid_id, game_id, square_index, task_entry_id, status, stamp_index, updated_at
         FROM squares WHERE game_id = $1 ORDER BY grid_id, square_index`,
      [gameId],
    ),
    transaction.query<SqlRequestRow>(
      `SELECT id, game_id, grid_id, square_index, requesting_participant_id,
              identified_participant_id, status, created_at, resolved_at,
              outcome_actor_id, client_command_id
         FROM verification_requests WHERE game_id = $1 ORDER BY created_at, id`,
      [gameId],
    ),
    transaction.query<SqlNotificationRow>(
      `SELECT id, game_id, recipient_participant_id, verification_request_id, kind,
              status, created_at, resolved_at
         FROM notifications WHERE game_id = $1 ORDER BY created_at, id`,
      [gameId],
    ),
    transaction.query<SqlCompletionRow>(
      `SELECT id, game_id, participant_id, category, completion_key,
              completed_at, created_at
         FROM completions WHERE game_id = $1 ORDER BY completed_at, id`,
      [gameId],
    ),
    transaction.query<SqlIdempotencyRow>(
      `SELECT scope_key, idempotency_key, command_type, state_version, result_json
         FROM command_idempotency WHERE game_id = $1 ORDER BY created_at, scope_key`,
      [gameId],
    ),
  ]);

  const idempotency = new Map<string, unknown>();
  for (const row of idempotencyResult.rows) {
    idempotency.set(row.scope_key, {
      commandType: row.command_type,
      result: row.result_json,
    });
  }

  return {
    game: {
      id: gameRow.id as GameId,
      hostAccountId: gameRow.host_account_id,
      name: gameRow.name,
      status: gameRow.status,
      taskBagLockedAt: asNullableDate(gameRow.task_bag_locked_at),
      closedAt: asNullableDate(gameRow.closed_at),
      stateVersion: asBigInt(gameRow.state_version),
      createdAt: asDate(gameRow.created_at),
      updatedAt: asDate(gameRow.updated_at),
    },
    tasks: taskResult.rows.map((row) => ({
      id: row.id as TaskEntryRecord['id'],
      gameId: row.game_id as GameId,
      displayText: row.display_text,
      normalizedText: row.normalized_text,
      createdAt: asDate(row.created_at),
      updatedAt: asDate(row.updated_at),
      removedAt: asNullableDate(row.removed_at),
    })),
    participants: participantResult.rows.map((row) => ({
      id: row.id as ParticipantId,
      gameId: row.game_id as GameId,
      createdAt: asDate(row.created_at),
      leftAt: asNullableDate(row.left_at),
    })),
    memberships: membershipResult.rows.map((row) => ({
      id: row.id as MembershipRecord['id'],
      gameId: row.game_id as GameId,
      participantId: row.participant_id as ParticipantId,
      identityKey: row.identity_key,
      browserSessionId: row.browser_session_id as MembershipRecord['browserSessionId'],
      resumableCredentialHash: new Uint8Array(row.resumable_credential_hash),
      createdAt: asDate(row.created_at),
      lastSeenAt: asDate(row.last_seen_at),
    })),
    profiles: profileResult.rows.map((row) => ({
      id: row.id as PlayerProfileRecord['id'],
      gameId: row.game_id as GameId,
      participantId: row.participant_id as ParticipantId,
      displayName: row.display_name,
      playerCode: row.player_code,
      createdAt: asDate(row.created_at),
    })),
    grids: gridResult.rows.map((row) => ({
      id: row.id as GridRecord['id'],
      gameId: row.game_id as GameId,
      participantId: row.participant_id as ParticipantId,
      taskBagVersion: asBigInt(row.task_bag_version),
      stateVersion: asBigInt(row.state_version),
      createdAt: asDate(row.created_at),
    })),
    squares: squareResult.rows.map((row) => ({
      gridId: row.grid_id as GridRecord['id'],
      gameId: row.game_id as GameId,
      squareIndex: row.square_index,
      taskEntryId: row.task_entry_id as SquareRecord['taskEntryId'],
      status: row.status,
      ...(row.stamp_index === null ? {} : { stampIndex: row.stamp_index }),
      updatedAt: asDate(row.updated_at),
    })),
    verificationRequests: requestResult.rows.map((row) => ({
      id: row.id as VerificationRequestRecord['id'],
      gameId: row.game_id as GameId,
      gridId: row.grid_id as GridRecord['id'],
      squareIndex: row.square_index,
      requestingParticipantId: row.requesting_participant_id as ParticipantId,
      identifiedParticipantId: row.identified_participant_id as ParticipantId,
      status: row.status,
      createdAt: asDate(row.created_at),
      resolvedAt: asNullableDate(row.resolved_at),
      outcomeActorId: row.outcome_actor_id as ParticipantId | null,
      clientCommandId: row.client_command_id,
    })),
    notifications: notificationResult.rows.map((row) => ({
      id: row.id as NotificationRecord['id'],
      gameId: row.game_id as GameId,
      recipientParticipantId: row.recipient_participant_id as ParticipantId,
      verificationRequestId: row.verification_request_id as VerificationRequestRecord['id'],
      kind: row.kind,
      status: row.status,
      createdAt: asDate(row.created_at),
      resolvedAt: asNullableDate(row.resolved_at),
    })),
    completions: completionResult.rows.map((row) => ({
      id: row.id as CompletionRecord['id'],
      gameId: row.game_id as GameId,
      participantId: row.participant_id as ParticipantId,
      category: row.category,
      completionKey: row.completion_key as CompletionRecord['completionKey'],
      completedAt: asDate(row.completed_at),
      createdAt: asDate(row.created_at),
    })),
    idempotency,
  };
}

async function persistState(transaction: SqlTransaction, state: VerificationState): Promise<void> {
  await transaction.query(
    `UPDATE games
        SET status = $2, updated_at = $3, state_version = $4
      WHERE id = $1`,
    [state.game.id, state.game.status, state.game.updatedAt, state.game.stateVersion],
  );
  for (const square of state.squares) {
    await transaction.query(
      `INSERT INTO squares
         (grid_id, game_id, square_index, task_entry_id, status, stamp_index, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (grid_id, square_index) DO UPDATE
          SET status = EXCLUDED.status, stamp_index = EXCLUDED.stamp_index,
              updated_at = EXCLUDED.updated_at`,
      [
        square.gridId,
        square.gameId,
        square.squareIndex,
        square.taskEntryId,
        square.status,
        square.stampIndex ?? null,
        square.updatedAt,
      ],
    );
  }
  for (const request of state.verificationRequests) {
    await transaction.query(
      `INSERT INTO verification_requests
         (id, game_id, grid_id, square_index, requesting_participant_id,
          identified_participant_id, status, created_at, resolved_at,
          outcome_actor_id, client_command_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE
          SET status = EXCLUDED.status, resolved_at = EXCLUDED.resolved_at,
              outcome_actor_id = EXCLUDED.outcome_actor_id`,
      [
        request.id,
        request.gameId,
        request.gridId,
        request.squareIndex,
        request.requestingParticipantId,
        request.identifiedParticipantId,
        request.status,
        request.createdAt,
        request.resolvedAt,
        request.outcomeActorId,
        request.clientCommandId,
      ],
    );
  }
  for (const notification of state.notifications) {
    await transaction.query(
      `INSERT INTO notifications
         (id, game_id, recipient_participant_id, verification_request_id,
          kind, status, created_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE
          SET status = EXCLUDED.status, resolved_at = EXCLUDED.resolved_at`,
      [
        notification.id,
        notification.gameId,
        notification.recipientParticipantId,
        notification.verificationRequestId,
        notification.kind,
        notification.status,
        notification.createdAt,
        notification.resolvedAt,
      ],
    );
  }
  for (const completion of state.completions) {
    await transaction.query(
      `INSERT INTO completions
         (id, game_id, participant_id, category, completion_key,
          completed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        completion.id,
        completion.gameId,
        completion.participantId,
        completion.category,
        completion.completionKey,
        completion.completedAt,
        completion.createdAt,
      ],
    );
  }
  for (const [scopeKey, stored] of state.idempotency) {
    const entry = stored as { readonly commandType: string; readonly result: unknown };
    const { gameId, idempotencyKey } = splitScopeKey(scopeKey);
    const resultVersion = (entry.result as { stateVersion?: unknown } | null)?.stateVersion;
    const stateVersion = typeof resultVersion === 'number' ? BigInt(resultVersion) : null;
    await transaction.query(
      `INSERT INTO command_idempotency
         (scope_key, game_id, idempotency_key, command_type, state_version, result_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (scope_key) DO UPDATE
          SET command_type = EXCLUDED.command_type, state_version = EXCLUDED.state_version,
              result_json = EXCLUDED.result_json`,
      [
        scopeKey,
        gameId,
        idempotencyKey,
        entry.commandType,
        stateVersion,
        JSON.stringify(entry.result),
      ],
    );
  }
}

/** Scope keys are `gameId:actorId:idempotencyKey`; the first two segments are UUIDs. */
function splitScopeKey(scopeKey: string): {
  readonly gameId: GameId;
  readonly idempotencyKey: string;
} {
  const separator = scopeKey.indexOf(':');
  const second = separator < 0 ? -1 : scopeKey.indexOf(':', separator + 1);
  return {
    gameId: (separator < 0 ? scopeKey : scopeKey.slice(0, separator)) as GameId,
    idempotencyKey: second < 0 ? '' : scopeKey.slice(second + 1),
  };
}

/**
 * PostgreSQL-backed verification aggregate. Every request/response command
 * loads the full game state with the game row locked, stages the mutation, and
 * commits game, square, request, notification, completion, and idempotency rows
 * together with the same commit-on-success semantics as the in-memory store.
 */
export class SqlVerificationRepository implements VerificationRepository {
  public constructor(private readonly client: SqlClient) {}

  public read(gameId: GameId): Promise<VerificationState> {
    return withTransaction(this.client, async (transaction) =>
      loadState(transaction, gameId, false),
    );
  }

  public withVerificationState<Result>(
    gameId: GameId,
    mutation: (state: VerificationState) => Promise<Result> | Result,
  ): Promise<Result> {
    return withTransaction(this.client, async (transaction) => {
      const state = await loadState(transaction, gameId);
      const previousVersion = state.game.stateVersion;
      const result = await mutation(state);
      await persistState(transaction, state);
      if (state.game.stateVersion > previousVersion)
        await appendGamePatchInvalidation(transaction, gameId, state.game.stateVersion);
      return result;
    });
  }
}
