import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  DomainErrorCode,
  GameStatus,
  HumanBingoError,
  type CorrelationId,
  type GameDto,
  type GameId,
  type GridDto,
  type MembershipDto,
  type OnboardParticipantCommand,
  type OnboardingResultDto,
  type ParticipantDto,
  type PlayerProfileDto,
  type StateVersion,
  type Timestamp,
} from '@human-bingo/domain';
import type {
  BrowserSessionId,
  MembershipRecord,
  MembershipRepository,
  MembershipState,
  ParticipantRecord,
  PlayerProfileRecord,
  SqlTransaction,
  SquareRecord,
} from '@human-bingo/persistence';
import {
  createMembershipRecord,
  createParticipantRecord,
  createPlayerProfileRecord,
} from '@human-bingo/persistence';
import type { MembershipAccessResult, SessionService } from './access/session-service.js';
import type { GridService } from './grid.js';

const PLAYER_CODE_LENGTH = 6;
const PLAYER_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const MAX_PLAYER_CODE_RETRIES = 8;

export interface MembershipSessionIssuer {
  createResumableCredential(): { readonly credential: string; readonly hash: Uint8Array };
  createMembershipSession(
    membership: MembershipRecord,
    resumableCredential: string,
  ): Promise<MembershipAccessResult>;
  /** Binds a session inside the membership transaction without re-reading the row. */
  bindMembershipSession(
    membership: MembershipRecord,
    resumableCredential: string,
    transaction?: SqlTransaction,
  ): Promise<MembershipAccessResult>;
}

export interface MembershipServiceOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly playerCodeFactory?: () => string;
  readonly maxPlayerCodeRetries?: number;
  readonly sessionIssuer?: MembershipSessionIssuer | SessionService;
  readonly resumableCredentialHash?: (credential: string) => Uint8Array;
  /** Re-checks the invitation after the game row has been locked by the repository. */
  readonly assertInvitationUsable?: (input: {
    readonly correlationId: CorrelationId;
    readonly gameId: GameId;
    readonly invitation: OnboardParticipantCommand['input'];
  }) => Promise<void>;
}

export interface OnboardingServiceResult extends OnboardParticipantResultLike {
  readonly access?: MembershipAccessResult;
}

interface OnboardParticipantResultLike {
  readonly onboarding: OnboardingResultDto;
}

/**
 * Coordinates participant/profile/membership/grid creation in one repository
 * transaction. The repository commits its staged state only after this method
 * returns, so Player_Code, grid, and session-binding failures leave no rows.
 */
export class MembershipService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly playerCodeFactory: () => string;
  private readonly maxPlayerCodeRetries: number;
  private readonly sessionIssuer: MembershipSessionIssuer | undefined;
  private readonly resumableCredentialHash: MembershipServiceOptions['resumableCredentialHash'];
  private readonly assertInvitationUsable: MembershipServiceOptions['assertInvitationUsable'];

  public constructor(
    private readonly repository: MembershipRepository,
    private readonly gridService: GridService,
    options: MembershipServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.randomBytes = options.randomBytes ?? ((size) => new Uint8Array(randomBytes(size)));
    this.playerCodeFactory =
      options.playerCodeFactory ?? (() => randomPlayerCode(this.randomBytes));
    this.maxPlayerCodeRetries = options.maxPlayerCodeRetries ?? MAX_PLAYER_CODE_RETRIES;
    if (!Number.isInteger(this.maxPlayerCodeRetries) || this.maxPlayerCodeRetries < 1) {
      throw new Error('maxPlayerCodeRetries must be a positive integer');
    }
    this.sessionIssuer = options.sessionIssuer;
    this.resumableCredentialHash = options.resumableCredentialHash;
    this.assertInvitationUsable = options.assertInvitationUsable;
  }

  public async onboard(
    command: OnboardParticipantCommand,
    identityKey = command.participantIdentity ?? `idempotency:${String(command.idempotencyKey)}`,
  ): Promise<OnboardingServiceResult> {
    const normalizedIdentity = normalizeIdentity(identityKey, command.correlationId);
    const displayName = normalizeDisplayName(command.displayName, command.correlationId);

    try {
      return await this.repository.withMembershipState(
        requireGameId(command.gameId, command.correlationId),
        normalizedIdentity,
        async (state, transaction) =>
          this.onboardInState(state, command, normalizedIdentity, displayName, transaction),
      );
    } catch (error: unknown) {
      if (error instanceof HumanBingoError) throw error;
      throw new HumanBingoError({
        code: DomainErrorCode.OnboardingRetryable,
        message: 'Onboarding could not be completed. Please retry.',
        correlationId: command.correlationId,
        retryable: true,
        httpStatus: 503,
      });
    }
  }

  /** Resume through the opaque credential stored on the membership row. */
  public async resumeByCredential(
    gameId: GameId,
    resumableCredential: string,
    correlationId: CorrelationId,
  ): Promise<OnboardingServiceResult> {
    if (this.resumableCredentialHash === undefined) throw onboardingNotFound(correlationId);
    try {
      const membership = await this.repository.findMembershipByCredentialHash(
        gameId,
        this.resumableCredentialHash(resumableCredential),
      );
      if (membership === null) throw onboardingNotFound(correlationId);
      const identityKey = membership.identityKey ?? `membership:${String(membership.id)}`;
      return await this.repository.withMembershipState(gameId, identityKey, async (state) => {
        const current = state.memberships.find((item) => item.id === membership.id);
        if (current === undefined) throw onboardingNotFound(correlationId);
        const participant = state.participants.find((item) => item.id === current.participantId);
        const profile = state.playerProfiles.find(
          (item) => item.participantId === current.participantId,
        );
        if (participant === undefined || profile === undefined)
          throw onboardingNotFound(correlationId);
        const gridResult = this.gridService.generateOrResumeInState(state, {
          gameId,
          participantId: participant.id,
          correlationId,
        });
        const baseUpdated = { ...current, lastSeenAt: this.now() };
        let access: MembershipAccessResult | undefined;
        if (this.sessionIssuer !== undefined) {
          access = await this.sessionIssuer.bindMembershipSession(
            baseUpdated,
            resumableCredential,
          );
        }
        const updated: MembershipRecord =
          access === undefined
            ? baseUpdated
            : { ...baseUpdated, browserSessionId: access.session.id };
        const index = state.memberships.findIndex((item) => item.id === current.id);
        if (index >= 0) state.memberships[index] = updated;
        return {
          onboarding: toOnboardingResult(
            state,
            updated,
            participant,
            profile,
            gridResult.grid.id,
            gridResult.squares,
            true,
          ),
          ...(access === undefined ? {} : { access }),
        };
      });
    } catch (error: unknown) {
      if (error instanceof HumanBingoError) throw error;
      throw onboardingFailure(correlationId, 'Resume access could not be restored. Please retry.');
    }
  }

  /** Resume by the same stable browser/guest identity without creating rows. */
  public async resume(
    gameId: GameId,
    identityKey: string,
    correlationId: CorrelationId,
  ): Promise<OnboardingServiceResult> {
    const normalizedIdentity = normalizeIdentity(identityKey, correlationId);
    try {
      return await this.repository.withMembershipState(gameId, normalizedIdentity, (state) => {
        const membership = findMembership(state, normalizedIdentity);
        if (membership === undefined) throw onboardingNotFound(correlationId);
        const participant = state.participants.find((item) => item.id === membership.participantId);
        const profile = state.playerProfiles.find(
          (item) => item.participantId === membership.participantId,
        );
        if (participant === undefined || profile === undefined)
          throw onboardingNotFound(correlationId);
        const gridResult = this.gridService.generateOrResumeInState(state, {
          gameId,
          participantId: participant.id,
          correlationId,
        });
        return {
          onboarding: toOnboardingResult(
            state,
            membership,
            participant,
            profile,
            gridResult.grid.id,
            gridResult.squares,
            true,
          ),
        };
      });
    } catch (error: unknown) {
      if (error instanceof HumanBingoError) throw error;
      throw new HumanBingoError({
        code: DomainErrorCode.OnboardingRetryable,
        message: 'Resume access could not be restored. Please retry.',
        correlationId,
        retryable: true,
        httpStatus: 503,
      });
    }
  }

  private async onboardInState(
    state: MembershipState,
    command: OnboardParticipantCommand,
    identityKey: string,
    displayName: string,
    transaction?: SqlTransaction,
  ): Promise<OnboardingServiceResult> {
    if (this.assertInvitationUsable !== undefined) {
      await this.assertInvitationUsable({
        correlationId: command.correlationId,
        gameId: state.game.id,
        invitation: command.input,
      });
    }

    const existingMembership = findMembership(state, identityKey);
    if (existingMembership !== undefined) {
      const participant = state.participants.find(
        (item) => item.id === existingMembership.participantId,
      );
      const profile = state.playerProfiles.find(
        (item) => item.participantId === existingMembership.participantId,
      );
      if (participant === undefined || profile === undefined) {
        throw onboardingFailure(
          command.correlationId,
          'The existing membership is incomplete. Please retry.',
        );
      }
      const updatedMembership = { ...existingMembership, lastSeenAt: this.now() };
      const membershipIndex = state.memberships.findIndex(
        (item) => item.id === existingMembership.id,
      );
      if (membershipIndex >= 0) state.memberships[membershipIndex] = updatedMembership;
      const gridResult = this.gridService.generateOrResumeInState(state, {
        gameId: state.game.id,
        participantId: participant.id,
        correlationId: command.correlationId,
      });
      return {
        onboarding: toOnboardingResult(
          state,
          updatedMembership,
          participant,
          profile,
          gridResult.grid.id,
          gridResult.squares,
          true,
        ),
      };
    }

    if (state.game.status === GameStatus.Closed) {
      throw new HumanBingoError({
        code: DomainErrorCode.GameClosed,
        message: 'The game is closed.',
        correlationId: command.correlationId,
        retryable: false,
        httpStatus: 409,
      });
    }
    if (
      state.game.status !== GameStatus.InvitationAvailable &&
      state.game.status !== GameStatus.Active
    ) {
      throw new HumanBingoError({
        code: DomainErrorCode.InvitationInvalid,
        message: 'The game is not accepting participants.',
        correlationId: command.correlationId,
        retryable: false,
        httpStatus: 404,
      });
    }
    if (state.tasks.filter((task) => task.removedAt === null).length < 25) {
      throw new HumanBingoError({
        code: DomainErrorCode.InsufficientTasks,
        message: 'At least 25 distinct task entries are required before joining.',
        correlationId: command.correlationId,
        retryable: false,
        httpStatus: 409,
      });
    }

    const now = new Date(this.now());
    const participant = createParticipantRecord({
      id: this.idFactory() as ParticipantRecord['id'],
      gameId: state.game.id,
      now,
    });
    const profile = createPlayerProfileRecord({
      id: this.idFactory() as PlayerProfileRecord['id'],
      gameId: state.game.id,
      participantId: participant.id,
      displayName,
      playerCode: this.generateUniquePlayerCode(state, command.correlationId),
      now,
    });
    const credentials =
      this.sessionIssuer?.createResumableCredential() ?? fallbackCredential(this.randomBytes);
    const membership: MembershipRecord = createMembershipRecord({
      id: this.idFactory() as MembershipRecord['id'],
      gameId: state.game.id,
      participantId: participant.id,
      identityKey,
      browserSessionId: this.idFactory() as BrowserSessionId,
      resumableCredentialHash: credentials.hash,
      now,
    });

    state.participants.push(participant);
    state.playerProfiles.push(profile);
    state.memberships.push(membership);
    state.game = {
      ...state.game,
      status: GameStatus.Active,
      taskBagLockedAt: state.game.taskBagLockedAt === null ? now : state.game.taskBagLockedAt,
      updatedAt: now,
      stateVersion: state.game.stateVersion + 1n,
    };

    const gridResult = this.gridService.generateOrResumeInState(state, {
      gameId: state.game.id,
      participantId: participant.id,
      correlationId: command.correlationId,
    });

    let access: MembershipAccessResult | undefined;
    if (this.sessionIssuer !== undefined) {
      access = await this.sessionIssuer.bindMembershipSession(
        membership,
        credentials.credential,
        transaction,
      );
      const index = state.memberships.findIndex((item) => item.id === membership.id);
      if (index >= 0)
        state.memberships[index] = {
          ...membership,
          browserSessionId: access.session.id,
        };
    }

    return {
      onboarding: toOnboardingResult(
        state,
        membership,
        participant,
        profile,
        gridResult.grid.id,
        gridResult.squares,
        false,
      ),
      ...(access === undefined ? {} : { access }),
    };
  }

  private generateUniquePlayerCode(state: MembershipState, correlationId: CorrelationId): string {
    const used = new Set(state.playerProfiles.map((profile) => profile.playerCode));
    for (let attempt = 0; attempt < this.maxPlayerCodeRetries; attempt += 1) {
      const candidate = this.playerCodeFactory().trim();
      if (candidate.length > 0 && candidate.length <= 64 && !used.has(candidate)) return candidate;
    }
    throw new HumanBingoError({
      code: DomainErrorCode.PlayerCodeGenerationFailed,
      message: 'A unique Player_Code could not be generated. Please retry onboarding.',
      correlationId,
      retryable: true,
      httpStatus: 503,
    });
  }
}

const requireGameId = (gameId: GameId | undefined, correlationId: CorrelationId): GameId => {
  if (gameId !== undefined) return gameId;
  throw new HumanBingoError({
    code: DomainErrorCode.ValidationError,
    message: 'The onboarding game is required.',
    correlationId,
    retryable: false,
    httpStatus: 422,
  });
};

const findMembership = (
  state: MembershipState,
  identityKey: string,
): MembershipRecord | undefined =>
  state.memberships.find((membership) => membership.identityKey === identityKey);

const normalizeIdentity = (value: string, correlationId: CorrelationId): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256) {
    throw new HumanBingoError({
      code: DomainErrorCode.ValidationError,
      message: 'A stable participant identity is required.',
      correlationId,
      retryable: false,
      httpStatus: 422,
    });
  }
  return normalized;
};

const normalizeDisplayName = (value: string, correlationId: CorrelationId): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 128) {
    throw new HumanBingoError({
      code: DomainErrorCode.ValidationError,
      message: 'Display name is required.',
      correlationId,
      retryable: false,
      httpStatus: 422,
    });
  }
  return normalized;
};

const onboardingFailure = (correlationId: CorrelationId, message: string): HumanBingoError =>
  new HumanBingoError({
    code: DomainErrorCode.OnboardingRetryable,
    message,
    correlationId,
    retryable: true,
    httpStatus: 503,
  });

const onboardingNotFound = (correlationId: CorrelationId): HumanBingoError =>
  new HumanBingoError({
    code: DomainErrorCode.Unauthorized,
    message: 'Resume access is invalid.',
    correlationId,
    retryable: false,
    httpStatus: 401,
  });

const randomPlayerCode = (nextBytes: (size: number) => Uint8Array): string => {
  const bytes = nextBytes(PLAYER_CODE_LENGTH);
  let code = '';
  for (let index = 0; index < PLAYER_CODE_LENGTH; index += 1) {
    code += PLAYER_CODE_ALPHABET[(bytes[index] ?? 0) % PLAYER_CODE_ALPHABET.length] ?? 'A';
  }
  return code;
};

const fallbackCredential = (
  nextBytes: (size: number) => Uint8Array,
): {
  readonly credential: string;
  readonly hash: Uint8Array;
} => {
  const bytes = nextBytes(32);
  const credential = Buffer.from(bytes).toString('base64url');
  return { credential, hash: new Uint8Array(createHash('sha256').update(credential).digest()) };
};

const toOnboardingResult = (
  state: MembershipState,
  membership: MembershipRecord,
  participant: ParticipantRecord,
  profile: PlayerProfileRecord,
  gridId: string,
  squares: readonly SquareRecord[],
  resumed: boolean,
): OnboardingResultDto => ({
  game: toGameDto(state),
  membership: toMembershipDto(membership),
  participant: toParticipantDto(participant, profile.displayName ?? ''),
  profile: toProfileDto(profile),
  grid: toGridDto(state, gridId, participant.id, squares),
  resumed,
  stateVersion: Number(state.game.stateVersion) as StateVersion,
});

const toGameDto = (state: MembershipState): GameDto => ({
  id: state.game.id,
  name: state.game.name,
  status: state.game.status,
  distinctTaskCount: new Set(
    state.tasks.filter((task) => task.removedAt === null).map((task) => task.normalizedText),
  ).size,
  taskBagLocked: state.game.taskBagLockedAt !== null,
  stateVersion: Number(state.game.stateVersion) as StateVersion,
  createdAt: state.game.createdAt.toISOString() as Timestamp,
  updatedAt: state.game.updatedAt.toISOString() as Timestamp,
  ...(state.game.closedAt === null
    ? {}
    : { closedAt: state.game.closedAt.toISOString() as Timestamp }),
});

const toMembershipDto = (record: MembershipRecord): MembershipDto => ({
  id: record.id,
  gameId: record.gameId,
  participantId: record.participantId,
  createdAt: record.createdAt.toISOString() as Timestamp,
  lastSeenAt: record.lastSeenAt.toISOString() as Timestamp,
});

const toParticipantDto = (record: ParticipantRecord, displayName: string): ParticipantDto => ({
  id: record.id,
  displayName,
  joinedAt: record.createdAt.toISOString() as Timestamp,
});

const toProfileDto = (record: PlayerProfileRecord): PlayerProfileDto => ({
  id: record.id,
  participantId: record.participantId,
  displayName: record.displayName ?? '',
  playerCode: record.playerCode as PlayerProfileDto['playerCode'],
  createdAt: record.createdAt.toISOString() as Timestamp,
});

const toGridDto = (
  state: MembershipState,
  gridId: string,
  participantId: ParticipantRecord['id'],
  squares: readonly SquareRecord[],
): GridDto => ({
  id: gridId as GridDto['id'],
  gameId: state.game.id,
  participantId,
  squares: squares
    .slice()
    .sort((left, right) => left.squareIndex - right.squareIndex)
    .map((square) => {
      const task = state.tasks.find((candidate) => candidate.id === square.taskEntryId);
      if (task === undefined) throw new Error('A persisted square references a missing task');
      return {
        gridId: square.gridId,
        squareIndex: square.squareIndex,
        row: (Math.floor(square.squareIndex / 5) + 1) as 1 | 2 | 3 | 4 | 5,
        column: ((square.squareIndex % 5) + 1) as 1 | 2 | 3 | 4 | 5,
        taskEntryId: square.taskEntryId,
        taskText: task.displayText,
        status: square.status,
        updatedAt: square.updatedAt.toISOString() as Timestamp,
      };
    }),
  taskBagVersion: 1 as StateVersion,
  stateVersion: Number(state.game.stateVersion) as StateVersion,
  createdAt: (
    state.grids.find((grid) => grid.id === gridId)?.createdAt ?? state.game.updatedAt
  ).toISOString() as Timestamp,
});
