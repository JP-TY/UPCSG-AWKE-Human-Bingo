import type { GameId } from '@human-bingo/domain';
import type { MembershipRepository, MembershipState } from './membership.js';
import type { D1DatabaseLike, D1Transaction } from './d1-transaction.js';
import { withD1Transaction } from './d1-transaction.js';
import { appendGamePatchInvalidation } from './realtime-outbox.js';
import type { MembershipRecord } from './models.js';
import type { SqlTransaction } from './transaction.js';

// D1 port of SqlMembershipRepository for Workers.
// Workers DO serializes per gameId, so FOR UPDATE is not needed.
// Uses "?" placeholders instead of "$1".

export class D1MembershipRepository implements MembershipRepository {
  public constructor(private readonly db: D1DatabaseLike) {}

  public async findMembershipByCredentialHash(
    gameId: GameId,
    credentialHash: Uint8Array,
  ): Promise<MembershipRecord | null> {
    const result = await withD1Transaction(this.db, async (tx) =>
      tx.query<SqlMembershipRow>(
        `SELECT id, game_id, participant_id, identity_key, browser_session_id,
                resumable_credential_hash, created_at, last_seen_at
           FROM memberships
          WHERE game_id = ? AND resumable_credential_hash = ?`,
        [gameId, credentialHash],
      ),
    );
    const row = result.rows[0] as unknown as SqlMembershipRow | undefined;
    return row === undefined ? null : membershipFromRow(row);
  }

  public async read(gameId: GameId): Promise<MembershipState> {
    return withD1Transaction(this.db, async (transaction) => loadState(transaction, gameId, false));
  }

  public async withMembershipState<Result>(
    gameId: GameId,
    _identityKey: string,
    mutation: (state: MembershipState, transaction?: D1Transaction) => Promise<Result> | Result,
  ): Promise<Result> {
    return withD1Transaction(this.db, async (transaction) => {
      const state = await loadState(transaction, gameId);
      const previousVersion = state.game.stateVersion;
      const result = await mutation(state, transaction);
      assertUniqueState(state);
      await persistState(transaction, state);
      if (state.game.stateVersion > previousVersion)
        await appendGamePatchInvalidation(transaction as unknown as SqlTransaction, gameId, state.game.stateVersion);
      return result;
    });
  }
}

import type {
  BrowserSessionId,
  GameRecord,
  GridRecord,
  MembershipId,
  ParticipantId,
  PlayerProfileId,
  SquareRecord,
  TaskEntryRecord,
} from './models.js';

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
  readonly updated_at: Date | string;
}

const asDate = (value: Date | string): Date => (value instanceof Date ? new Date(value) : new Date(value));
const asNullableDate = (value: Date | string | null): Date | null => (value === null ? null : asDate(value));
const asBigInt = (value: string | number | bigint): bigint => (typeof value === 'bigint' ? value : BigInt(value));
const membershipFromRow = (row: SqlMembershipRow): MembershipRecord => ({
  id: row.id as MembershipId,
  gameId: row.game_id as GameId,
  participantId: row.participant_id as ParticipantId,
  identityKey: row.identity_key,
  browserSessionId: row.browser_session_id as BrowserSessionId | null,
  resumableCredentialHash: new Uint8Array(row.resumable_credential_hash),
  createdAt: asDate(row.created_at),
  lastSeenAt: asDate(row.last_seen_at),
});

async function loadState(transaction: D1Transaction, gameId: GameId, _lock = true): Promise<MembershipState> {
  void _lock;
  const gameResult = await transaction.query<SqlGameRow>(
    `SELECT id, host_account_id, name, status, task_bag_locked_at, closed_at,
            state_version, created_at, updated_at
       FROM games WHERE id = ?`,
    [gameId],
  );
  const gameRow = gameResult.rows[0] as unknown as SqlGameRow | undefined;
  if (gameRow === undefined) throw new Error(`Membership game ${gameId} was not found`);

  const [taskResult, participantResult, membershipResult, profileResult, gridResult, squareResult] = await Promise.all([
    transaction.query<SqlTaskRow>(
      `SELECT id, game_id, display_text, normalized_text, created_at, updated_at, removed_at
         FROM task_entries WHERE game_id = ? ORDER BY created_at, id`,
      [gameId],
    ),
    transaction.query<SqlParticipantRow>(`SELECT id, game_id, created_at, left_at FROM participants WHERE game_id = ?`, [gameId]),
    transaction.query<SqlMembershipRow>(
      `SELECT id, game_id, participant_id, identity_key, browser_session_id,
              resumable_credential_hash, created_at, last_seen_at
         FROM memberships WHERE game_id = ?`,
      [gameId],
    ),
    transaction.query<SqlProfileRow>(
      `SELECT id, game_id, participant_id, display_name, player_code, created_at
         FROM player_profiles WHERE game_id = ?`,
      [gameId],
    ),
    transaction.query<SqlGridRow>(
      `SELECT id, game_id, participant_id, task_bag_version, state_version, created_at
         FROM grids WHERE game_id = ?`,
      [gameId],
    ),
    transaction.query<SqlSquareRow>(
      `SELECT square.grid_id, square.game_id, square.square_index,
              square.task_entry_id, square.status, square.updated_at
         FROM squares AS square
         JOIN grids AS grid ON grid.id = square.grid_id AND grid.game_id = ?
        WHERE square.game_id = ? ORDER BY square.grid_id, square.square_index`,
      [gameId, gameId],
    ),
  ]);

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
      id: (row as unknown as SqlTaskRow).id as TaskEntryRecord['id'],
      gameId: (row as unknown as SqlTaskRow).game_id as GameId,
      displayText: (row as unknown as SqlTaskRow).display_text,
      normalizedText: (row as unknown as SqlTaskRow).normalized_text,
      createdAt: asDate((row as unknown as SqlTaskRow).created_at),
      updatedAt: asDate((row as unknown as SqlTaskRow).updated_at),
      removedAt: asNullableDate((row as unknown as SqlTaskRow).removed_at),
    })),
    participants: participantResult.rows.map((row) => ({
      id: (row as unknown as SqlParticipantRow).id as ParticipantId,
      gameId: (row as unknown as SqlParticipantRow).game_id as GameId,
      createdAt: asDate((row as unknown as SqlParticipantRow).created_at),
      leftAt: asNullableDate((row as unknown as SqlParticipantRow).left_at),
    })),
    memberships: membershipResult.rows.map((row) => membershipFromRow(row as unknown as SqlMembershipRow)),
    playerProfiles: profileResult.rows.map((row) => ({
      id: (row as unknown as SqlProfileRow).id as PlayerProfileId,
      gameId: (row as unknown as SqlProfileRow).game_id as GameId,
      participantId: (row as unknown as SqlProfileRow).participant_id as ParticipantId,
      displayName: (row as unknown as SqlProfileRow).display_name,
      playerCode: (row as unknown as SqlProfileRow).player_code,
      createdAt: asDate((row as unknown as SqlProfileRow).created_at),
    })),
    grids: gridResult.rows.map((row) => ({
      id: (row as unknown as SqlGridRow).id as GridRecord['id'],
      gameId: (row as unknown as SqlGridRow).game_id as GameId,
      participantId: (row as unknown as SqlGridRow).participant_id as ParticipantId,
      taskBagVersion: asBigInt((row as unknown as SqlGridRow).task_bag_version),
      stateVersion: asBigInt((row as unknown as SqlGridRow).state_version),
      createdAt: asDate((row as unknown as SqlGridRow).created_at),
    })),
    squares: squareResult.rows.map((row) => ({
      gridId: (row as unknown as SqlSquareRow).grid_id as GridRecord['id'],
      gameId: (row as unknown as SqlSquareRow).game_id as GameId,
      squareIndex: (row as unknown as SqlSquareRow).square_index,
      taskEntryId: (row as unknown as SqlSquareRow).task_entry_id as SquareRecord['taskEntryId'],
      status: (row as unknown as SqlSquareRow).status,
      updatedAt: asDate((row as unknown as SqlSquareRow).updated_at),
    })),
  };
}

async function persistState(transaction: D1Transaction, state: MembershipState): Promise<void> {
  await transaction.query(
    `UPDATE games SET status = ?, task_bag_locked_at = ?, updated_at = ?,
                      state_version = ? WHERE id = ?`,
    [state.game.status, state.game.taskBagLockedAt, state.game.updatedAt, Number(state.game.stateVersion), state.game.id],
  );
  for (const participant of state.participants) {
    await transaction.query(
      `INSERT INTO participants (id, game_id, created_at, left_at)
       VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      [participant.id, participant.gameId, participant.createdAt.toISOString(), participant.leftAt?.toISOString() ?? null],
    );
  }
  for (const membership of state.memberships) {
    await transaction.query(
      `INSERT INTO memberships
         (id, game_id, participant_id, identity_key, browser_session_id,
          resumable_credential_hash, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET last_seen_at = excluded.last_seen_at,
                                      browser_session_id = excluded.browser_session_id`,
      [
        membership.id,
        membership.gameId,
        membership.participantId,
        membership.identityKey,
        membership.browserSessionId,
        membership.resumableCredentialHash,
        membership.createdAt.toISOString(),
        membership.lastSeenAt.toISOString(),
      ],
    );
  }
  for (const profile of state.playerProfiles) {
    await transaction.query(
      `INSERT INTO player_profiles
         (id, game_id, participant_id, display_name, player_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      [profile.id, profile.gameId, profile.participantId, profile.displayName, profile.playerCode, profile.createdAt.toISOString()],
    );
  }
  for (const grid of state.grids) {
    await transaction.query(
      `INSERT INTO grids
         (id, game_id, participant_id, task_bag_version, state_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      [grid.id, grid.gameId, grid.participantId, Number(grid.taskBagVersion), Number(grid.stateVersion), grid.createdAt.toISOString()],
    );
  }
  for (const square of state.squares) {
    await transaction.query(
      `INSERT INTO squares
         (grid_id, game_id, square_index, task_entry_id, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (grid_id, square_index) DO UPDATE SET status = excluded.status,
                                                        updated_at = excluded.updated_at`,
      [square.gridId, square.gameId, square.squareIndex, square.taskEntryId, square.status, square.updatedAt.toISOString()],
    );
  }
}

const assertUniqueState = (state: MembershipState): void => {
  const participantKeys = new Set<string>();
  const membershipKeys = new Set<string>();
  const identityKeys = new Set<string>();
  const profileKeys = new Set<string>();
  const playerCodes = new Set<string>();
  const gridKeys = new Set<string>();
  for (const participant of state.participants) {
    const key = `${participant.gameId}:${participant.id}`;
    if (participantKeys.has(key)) throw new Error('Duplicate participant in onboarding transaction');
    participantKeys.add(key);
  }
  for (const membership of state.memberships) {
    const key = `${membership.gameId}:${membership.participantId}`;
    if (membershipKeys.has(key)) throw new Error('Duplicate membership in onboarding transaction');
    membershipKeys.add(key);
    if (membership.identityKey !== undefined) {
      const identityKey = `${membership.gameId}:${membership.identityKey}`;
      if (identityKeys.has(identityKey)) throw new Error('Duplicate onboarding identity');
      identityKeys.add(identityKey);
    }
  }
  for (const profile of state.playerProfiles) {
    const key = `${profile.gameId}:${profile.participantId}`;
    if (profileKeys.has(key)) throw new Error('Duplicate profile in onboarding transaction');
    profileKeys.add(key);
    const codeKey = `${profile.gameId}:${profile.playerCode}`;
    if (playerCodes.has(codeKey)) throw new Error('Duplicate Player_Code in onboarding transaction');
    playerCodes.add(codeKey);
  }
  for (const grid of state.grids) {
    const key = `${grid.gameId}:${grid.participantId}`;
    if (gridKeys.has(key)) throw new Error('Duplicate grid in onboarding transaction');
    gridKeys.add(key);
  }
};
