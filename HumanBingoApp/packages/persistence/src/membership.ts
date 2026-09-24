import { randomUUID } from 'node:crypto';

import type { GameId, MembershipId, ParticipantId, PlayerProfileId } from '@human-bingo/domain';
import type {
  BrowserSessionId,
  GameRecord,
  GridRecord,
  MembershipRecord,
  ParticipantRecord,
  PlayerProfileRecord,
  SquareRecord,
  TaskEntryRecord,
} from './models.js';
import type { GridState } from './grid.js';
import { appendGamePatchInvalidation } from './realtime-outbox.js';
import { withTransaction, type SqlClient, type SqlTransaction } from './transaction.js';

export interface MembershipState extends GridState {
  participants: ParticipantRecord[];
  memberships: MembershipRecord[];
  playerProfiles: PlayerProfileRecord[];
}

export interface MembershipRepository {
  withMembershipState<Result>(
    gameId: GameId,
    identityKey: string,
    mutation: (state: MembershipState, transaction?: SqlTransaction) => Promise<Result> | Result,
  ): Promise<Result>;
  findMembershipByCredentialHash(
    gameId: GameId,
    credentialHash: Uint8Array,
  ): Promise<MembershipRecord | null>;
  read(gameId: GameId): Promise<MembershipState>;
}

export interface InMemoryMembershipRepositoryOptions {
  readonly states?: readonly MembershipState[];
}

export class MembershipGameNotFoundError extends Error {
  public constructor(gameId: GameId) {
    super(`Membership game ${gameId} was not found`);
    this.name = 'MembershipGameNotFoundError';
  }
}

/**
 * Transactional membership store used by the application runtime and tests.
 * All onboarding rows, including the generated grid, are staged and committed
 * together only after the callback succeeds.
 */
export class InMemoryMembershipRepository implements MembershipRepository {
  private readonly games = new Map<GameId, MembershipState>();
  private readonly locks = new Map<GameId, Promise<void>>();

  public constructor(options: InMemoryMembershipRepositoryOptions = {}) {
    for (const state of options.states ?? []) this.games.set(state.game.id, cloneState(state));
  }

  public seed(state: MembershipState): void {
    if (this.games.has(state.game.id)) throw new Error(`Game ${state.game.id} already exists`);
    this.games.set(state.game.id, cloneState(state));
  }

  public read(gameId: GameId): Promise<MembershipState> {
    const state = this.games.get(gameId);
    if (state === undefined) throw new MembershipGameNotFoundError(gameId);
    return Promise.resolve(cloneState(state));
  }

  public findMembershipByCredentialHash(
    gameId: GameId,
    credentialHash: Uint8Array,
  ): Promise<MembershipRecord | null> {
    const state = this.games.get(gameId);
    if (state === undefined) throw new MembershipGameNotFoundError(gameId);
    const membership = state.memberships.find((item) =>
      bytesEqual(item.resumableCredentialHash, credentialHash),
    );
    return Promise.resolve(membership === undefined ? null : cloneMembership(membership));
  }

  public async withMembershipState<Result>(
    gameId: GameId,
    _identityKey: string,
    mutation: (state: MembershipState, _transaction?: SqlTransaction) => Promise<Result> | Result,
  ): Promise<Result> {
    const previous = this.locks.get(gameId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(gameId, current);
    await previous;

    try {
      const stored = this.games.get(gameId);
      if (stored === undefined) throw new MembershipGameNotFoundError(gameId);
      const staged = cloneState(stored);
      const result = await mutation(staged);
      assertUniqueState(staged);
      this.games.set(gameId, cloneState(staged));
      return result;
    } finally {
      release();
      if (this.locks.get(gameId) === current) this.locks.delete(gameId);
    }
  }
}

export class SqlMembershipRepository implements MembershipRepository {
  public constructor(private readonly client: SqlClient) {}

  public async findMembershipByCredentialHash(
    gameId: GameId,
    credentialHash: Uint8Array,
  ): Promise<MembershipRecord | null> {
    const result = await this.client.query<SqlMembershipRow>(
      `SELECT id, game_id, participant_id, identity_key, browser_session_id,
              resumable_credential_hash, created_at, last_seen_at
         FROM memberships
        WHERE game_id = $1 AND resumable_credential_hash = $2`,
      [gameId, credentialHash],
    );
    const row = result.rows[0];
    return row === undefined ? null : membershipFromRow(row);
  }

  public async read(gameId: GameId): Promise<MembershipState> {
    return withTransaction(this.client, async (transaction) => loadState(transaction, gameId, false));
  }

  public async withMembershipState<Result>(
    gameId: GameId,
    _identityKey: string,
    mutation: (state: MembershipState, transaction?: SqlTransaction) => Promise<Result> | Result,
  ): Promise<Result> {
    return withTransaction(this.client, async (transaction) => {
      const state = await loadState(transaction, gameId);
      const previousVersion = state.game.stateVersion;
      const result = await mutation(state, transaction);
      assertUniqueState(state);
      await persistState(transaction, state);
      if (state.game.stateVersion > previousVersion)
        await appendGamePatchInvalidation(transaction, gameId, state.game.stateVersion);
      return result;
    });
  }
}

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

const asDate = (value: Date | string): Date =>
  value instanceof Date ? new Date(value) : new Date(value);
const asNullableDate = (value: Date | string | null): Date | null =>
  value === null ? null : asDate(value);
const asBigInt = (value: string | number | bigint): bigint =>
  typeof value === 'bigint' ? value : BigInt(value);
const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);
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

async function loadState(
  transaction: SqlTransaction,
  gameId: GameId,
  lock = true,
): Promise<MembershipState> {
  const lockClause = lock ? ' FOR UPDATE' : '';
  const gameResult = await transaction.query<SqlGameRow>(
    `SELECT id, host_account_id, name, status, task_bag_locked_at, closed_at,
            state_version, created_at, updated_at
       FROM games WHERE id = $1${lockClause}`,
    [gameId],
  );
  const gameRow = gameResult.rows[0];
  if (gameRow === undefined) throw new MembershipGameNotFoundError(gameId);

  const [taskResult, participantResult, membershipResult, profileResult, gridResult, squareResult] =
    await Promise.all([
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
            FROM memberships WHERE game_id = $1${lockClause}`,
        [gameId],
      ),
      transaction.query<SqlProfileRow>(
        `SELECT id, game_id, participant_id, display_name, player_code, created_at
           FROM player_profiles WHERE game_id = $1`,
        [gameId],
      ),
      transaction.query<SqlGridRow>(
        `SELECT id, game_id, participant_id, task_bag_version, state_version, created_at
            FROM grids WHERE game_id = $1${lockClause}`,
        [gameId],
      ),
      transaction.query<SqlSquareRow>(
        `SELECT square.grid_id, square.game_id, square.square_index,
                square.task_entry_id, square.status, square.updated_at
           FROM squares AS square
           JOIN grids AS grid ON grid.id = square.grid_id AND grid.game_id = $1
          WHERE square.game_id = $1 ORDER BY square.grid_id, square.square_index`,
        [gameId],
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
      id: row.id as MembershipId,
      gameId: row.game_id as GameId,
      participantId: row.participant_id as ParticipantId,
      identityKey: row.identity_key,
      browserSessionId: row.browser_session_id as BrowserSessionId | null,
      resumableCredentialHash: new Uint8Array(row.resumable_credential_hash),
      createdAt: asDate(row.created_at),
      lastSeenAt: asDate(row.last_seen_at),
    })),
    playerProfiles: profileResult.rows.map((row) => ({
      id: row.id as PlayerProfileId,
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
      updatedAt: asDate(row.updated_at),
    })),
  };
}

async function persistState(transaction: SqlTransaction, state: MembershipState): Promise<void> {
  await transaction.query(
    `UPDATE games SET status = $2, task_bag_locked_at = $3, updated_at = $4,
                      state_version = $5 WHERE id = $1`,
    [
      state.game.id,
      state.game.status,
      state.game.taskBagLockedAt,
      state.game.updatedAt,
      state.game.stateVersion,
    ],
  );

  for (const participant of state.participants) {
    await transaction.query(
      `INSERT INTO participants (id, game_id, created_at, left_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [participant.id, participant.gameId, participant.createdAt, participant.leftAt],
    );
  }
  for (const membership of state.memberships) {
    await transaction.query(
      `INSERT INTO memberships
         (id, game_id, participant_id, identity_key, browser_session_id,
          resumable_credential_hash, created_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at,
                                      browser_session_id = EXCLUDED.browser_session_id`,
      [
        membership.id,
        membership.gameId,
        membership.participantId,
        membership.identityKey,
        membership.browserSessionId,
        membership.resumableCredentialHash,
        membership.createdAt,
        membership.lastSeenAt,
      ],
    );
  }
  for (const profile of state.playerProfiles) {
    await transaction.query(
      `INSERT INTO player_profiles
         (id, game_id, participant_id, display_name, player_code, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [
        profile.id,
        profile.gameId,
        profile.participantId,
        profile.displayName,
        profile.playerCode,
        profile.createdAt,
      ],
    );
  }
  for (const grid of state.grids) {
    await transaction.query(
      `INSERT INTO grids
         (id, game_id, participant_id, task_bag_version, state_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [
        grid.id,
        grid.gameId,
        grid.participantId,
        grid.taskBagVersion,
        grid.stateVersion,
        grid.createdAt,
      ],
    );
  }
  for (const square of state.squares) {
    await transaction.query(
      `INSERT INTO squares
         (grid_id, game_id, square_index, task_entry_id, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (grid_id, square_index) DO UPDATE SET status = EXCLUDED.status,
                                                        updated_at = EXCLUDED.updated_at`,
      [
        square.gridId,
        square.gameId,
        square.squareIndex,
        square.taskEntryId,
        square.status,
        square.updatedAt,
      ],
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
    if (participantKeys.has(key))
      throw new Error('Duplicate participant in onboarding transaction');
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
    if (playerCodes.has(codeKey))
      throw new Error('Duplicate Player_Code in onboarding transaction');
    playerCodes.add(codeKey);
  }
  for (const grid of state.grids) {
    const key = `${grid.gameId}:${grid.participantId}`;
    if (gridKeys.has(key)) throw new Error('Duplicate grid in onboarding transaction');
    gridKeys.add(key);
  }
};

const cloneState = (state: MembershipState): MembershipState => ({
  game: cloneGame(state.game),
  tasks: state.tasks.map(cloneTask),
  grids: state.grids.map(cloneGrid),
  squares: state.squares.map(cloneSquare),
  participants: state.participants.map(cloneParticipant),
  memberships: state.memberships.map(cloneMembership),
  playerProfiles: state.playerProfiles.map(cloneProfile),
});

const cloneGame = (record: GameRecord): GameRecord => ({
  ...record,
  taskBagLockedAt: record.taskBagLockedAt === null ? null : new Date(record.taskBagLockedAt),
  closedAt: record.closedAt === null ? null : new Date(record.closedAt),
  createdAt: new Date(record.createdAt),
  updatedAt: new Date(record.updatedAt),
});

const cloneTask = (record: TaskEntryRecord): TaskEntryRecord => ({
  ...record,
  createdAt: new Date(record.createdAt),
  updatedAt: new Date(record.updatedAt),
  removedAt: record.removedAt === null ? null : new Date(record.removedAt),
});

const cloneParticipant = (record: ParticipantRecord): ParticipantRecord => ({
  ...record,
  createdAt: new Date(record.createdAt),
  leftAt: record.leftAt === null ? null : new Date(record.leftAt),
});

const cloneMembership = (record: MembershipRecord): MembershipRecord => ({
  ...record,
  resumableCredentialHash: new Uint8Array(record.resumableCredentialHash),
  createdAt: new Date(record.createdAt),
  lastSeenAt: new Date(record.lastSeenAt),
});

const cloneProfile = (record: PlayerProfileRecord): PlayerProfileRecord => ({
  ...record,
  createdAt: new Date(record.createdAt),
});

const cloneGrid = (record: GridRecord): GridRecord => ({
  ...record,
  createdAt: new Date(record.createdAt),
});

const cloneSquare = (record: SquareRecord): SquareRecord => ({
  ...record,
  updatedAt: new Date(record.updatedAt),
});

export const createMembershipRecord = (input: {
  readonly id?: MembershipId;
  readonly gameId: GameId;
  readonly participantId: ParticipantId;
  readonly identityKey: string;
  readonly browserSessionId?: BrowserSessionId | null;
  readonly resumableCredentialHash: Uint8Array;
  readonly now: Date;
}): MembershipRecord => ({
  id: input.id ?? (randomUUID() as MembershipId),
  gameId: input.gameId,
  participantId: input.participantId,
  identityKey: input.identityKey,
  browserSessionId: input.browserSessionId === undefined ? null : input.browserSessionId,
  resumableCredentialHash: new Uint8Array(input.resumableCredentialHash),
  createdAt: new Date(input.now),
  lastSeenAt: new Date(input.now),
});

export const createParticipantRecord = (input: {
  readonly id?: ParticipantId;
  readonly gameId: GameId;
  readonly now: Date;
}): ParticipantRecord => ({
  id: input.id ?? (randomUUID() as ParticipantId),
  gameId: input.gameId,
  createdAt: new Date(input.now),
  leftAt: null,
});

export const createPlayerProfileRecord = (input: {
  readonly id?: PlayerProfileId;
  readonly gameId: GameId;
  readonly participantId: ParticipantId;
  readonly displayName: string;
  readonly playerCode: string;
  readonly now: Date;
}): PlayerProfileRecord => ({
  id: input.id ?? (randomUUID() as PlayerProfileId),
  gameId: input.gameId,
  participantId: input.participantId,
  displayName: input.displayName,
  playerCode: input.playerCode,
  createdAt: new Date(input.now),
});
