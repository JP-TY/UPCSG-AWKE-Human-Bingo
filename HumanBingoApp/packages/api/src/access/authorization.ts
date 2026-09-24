import { DomainErrorCode, GameStatus, HumanBingoError } from '@human-bingo/domain';
import type {
  GameId,
  MembershipId,
  ParticipantId,
  VerificationRequestId,
  VerificationRequestStatus,
} from '@human-bingo/domain';
import type { MembershipRecord } from '@human-bingo/persistence';

export interface AuthorizationPrincipal {
  readonly accountOrGuestIdentity: string;
  readonly membershipId?: MembershipId;
  readonly participantId?: ParticipantId;
  readonly authorizationVersion?: bigint;
}

export interface GameAuthorizationInput {
  readonly gameId: GameId;
  readonly principal: AuthorizationPrincipal;
}

export interface ResumableAuthorizationInput extends GameAuthorizationInput {
  /** The participant binding resolved from the resumable credential. */
  readonly participantId: ParticipantId;
}

export interface VerificationResponseAuthorizationInput extends GameAuthorizationInput {
  readonly verificationRequestId: VerificationRequestId;
}

export interface AuthorizationRepository {
  readonly findGame: (gameId: GameId) => Promise<{
    readonly id: GameId;
    readonly hostAccountId: string;
    readonly status: GameStatus;
  } | null>;
  readonly findMembership: (
    gameId: GameId,
    participantId: ParticipantId,
  ) => Promise<MembershipRecord | null>;
  /**
   * This lookup is intentionally scoped by game and request id. Implementations
   * must not accept a request id alone, because that would permit cross-game
   * existence disclosure at the authorization boundary.
   */
  readonly findVerificationRequest?: (
    gameId: GameId,
    verificationRequestId: VerificationRequestId,
  ) => Promise<{
    readonly gameId: GameId;
    readonly identifiedParticipantId: ParticipantId;
    readonly status: VerificationRequestStatus;
  } | null>;
}

export interface HostAuthorization {
  readonly gameId: GameId;
  readonly principal: AuthorizationPrincipal;
  readonly role: 'host';
  readonly status?: GameStatus;
}

export interface MemberAuthorization {
  readonly gameId: GameId;
  readonly principal: AuthorizationPrincipal;
  readonly participantId: ParticipantId;
  readonly membership: MembershipRecord;
  /** Closed games remain readable, but state-changing policies reject them. */
  readonly status?: GameStatus;
}

/**
 * Game channel subscription authorization. Subscribers may be either a joined
 * member (whose patches are game-scoped) or the game's host (who observes the
 * host overview). Hosts carry no participant identity on the channel.
 */
export type WebSocketSubscriptionAuthorization =
  | (MemberAuthorization & { readonly role?: 'member' })
  | HostAuthorization;

export interface VerificationResponseAuthorization extends MemberAuthorization {
  readonly verificationRequestId: VerificationRequestId;
  readonly identifiedParticipantId: ParticipantId;
}

export interface HostSetupQueryPolicy {
  readonly authorize: (input: GameAuthorizationInput) => Promise<HostAuthorization>;
}

export interface MemberSnapshotQueryPolicy {
  readonly authorize: (input: GameAuthorizationInput) => Promise<MemberAuthorization>;
}

export interface MemberMutationQueryPolicy {
  readonly authorize: (input: GameAuthorizationInput) => Promise<MemberAuthorization>;
}

export type LeaderboardQueryPolicy = MemberSnapshotQueryPolicy;

export interface ResumableAccessQueryPolicy {
  readonly authorize: (input: ResumableAuthorizationInput) => Promise<MemberAuthorization>;
}

export interface VerificationResponseQueryPolicy {
  readonly authorize: (
    input: VerificationResponseAuthorizationInput,
  ) => Promise<VerificationResponseAuthorization>;
}

export type WebSocketSubscriptionPolicy = {
  readonly authorize: (
    input: GameAuthorizationInput,
  ) => Promise<WebSocketSubscriptionAuthorization>;
};

const forbidden = (message: string): HumanBingoError =>
  new HumanBingoError({
    code: DomainErrorCode.Forbidden,
    message,
    correlationId: 'authorization' as never,
    retryable: false,
    httpStatus: 403,
  });

const gameClosed = (): HumanBingoError =>
  new HumanBingoError({
    code: DomainErrorCode.GameClosed,
    message: 'The game is closed.',
    correlationId: 'authorization' as never,
    retryable: false,
    httpStatus: 409,
  });

const notIdentified = (): HumanBingoError =>
  new HumanBingoError({
    code: DomainErrorCode.NotIdentifiedParticipant,
    message: 'Only the identified participant may respond to this request.',
    correlationId: 'authorization' as never,
    retryable: false,
    httpStatus: 403,
  });

export class AuthorizationMiddleware {
  public constructor(private readonly repository: AuthorizationRepository) {}

  public async authorizeHost(input: GameAuthorizationInput): Promise<HostAuthorization> {
    const game = await this.repository.findGame(input.gameId);
    if (game === null || game.hostAccountId !== input.principal.accountOrGuestIdentity) {
      throw forbidden('Access to this game is not permitted');
    }
    if (game.status === GameStatus.Closed) throw gameClosed();
    return {
      gameId: input.gameId,
      principal: input.principal,
      role: 'host',
      status: game.status,
    };
  }

  /** Member reads intentionally remain valid for closed games. */
  public async authorizeMember(input: GameAuthorizationInput): Promise<MemberAuthorization> {
    const game = await this.repository.findGame(input.gameId);
    if (game === null) throw forbidden('Game membership is required');
    const participantId = input.principal.participantId;
    if (participantId === undefined || input.principal.membershipId === undefined) {
      throw forbidden('Game membership is required');
    }
    const membership = await this.repository.findMembership(input.gameId, participantId);
    if (
      membership === null ||
      membership.id !== input.principal.membershipId ||
      membership.gameId !== input.gameId ||
      membership.participantId !== participantId ||
      input.principal.accountOrGuestIdentity !== `membership:${String(membership.id)}`
    ) {
      throw forbidden('Game membership is required');
    }
    return {
      gameId: input.gameId,
      principal: input.principal,
      participantId,
      membership,
      status: game.status,
    };
  }

  /**
   * Game subscribe authorization for the realtime channel. A principal is
   * allowed when they are a joined member or the game's host. The member
   * identity binding and the host account identity are mutually exclusive by
   * construction, so the host branch can only apply when membership fails.
   */
  public async authorizeWebSocketSubscriber(
    input: GameAuthorizationInput,
  ): Promise<WebSocketSubscriptionAuthorization> {
    const game = await this.repository.findGame(input.gameId);
    if (game === null) throw forbidden('Access to this game is not permitted');
    const participantId = input.principal.participantId;
    if (participantId !== undefined && input.principal.membershipId !== undefined) {
      const membership = await this.repository.findMembership(input.gameId, participantId);
      const isMember =
        membership !== null &&
        membership.id === input.principal.membershipId &&
        membership.gameId === input.gameId &&
        membership.participantId === participantId &&
        input.principal.accountOrGuestIdentity === `membership:${String(membership.id)}`;
      if (isMember) {
        return {
          gameId: input.gameId,
          principal: input.principal,
          role: 'member' as const,
          participantId,
          membership,
          status: game.status,
        };
      }
    }
    if (game.hostAccountId === input.principal.accountOrGuestIdentity) {
      return {
        gameId: input.gameId,
        principal: input.principal,
        role: 'host' as const,
        status: game.status,
      };
    }
    throw forbidden('Access to this game is not permitted');
  }

  /** All state-changing member routes use this policy, so closed games are read-only. */
  public async authorizeMemberMutation(
    input: GameAuthorizationInput,
  ): Promise<MemberAuthorization> {
    const authorization = await this.authorizeMember(input);
    if (authorization.status === GameStatus.Closed) throw gameClosed();
    return authorization;
  }

  public async authorizeResumable(
    input: ResumableAuthorizationInput,
  ): Promise<MemberAuthorization> {
    if (input.principal.participantId !== input.participantId) {
      throw forbidden('Membership access is not permitted');
    }
    return this.authorizeMember(input);
  }

  public async authorizeVerificationResponse(
    input: VerificationResponseAuthorizationInput,
  ): Promise<VerificationResponseAuthorization> {
    const member = await this.authorizeMemberMutation(input);
    const request = await this.repository.findVerificationRequest?.(
      input.gameId,
      input.verificationRequestId,
    );
    if (request === null || request === undefined || request.gameId !== input.gameId) {
      // Do not disclose whether a request exists in another game.
      throw forbidden('Access to this verification request is not permitted');
    }
    if (request.identifiedParticipantId !== member.participantId) throw notIdentified();
    return {
      ...member,
      verificationRequestId: input.verificationRequestId,
      identifiedParticipantId: request.identifiedParticipantId,
    };
  }
}

export class ScopedQueryPolicies {
  public readonly hostSetup: HostSetupQueryPolicy;
  public readonly memberSnapshot: MemberSnapshotQueryPolicy;
  public readonly memberMutation?: MemberMutationQueryPolicy;
  public readonly leaderboard: LeaderboardQueryPolicy;
  public readonly resumableAccess: ResumableAccessQueryPolicy;
  public readonly verificationResponse?: VerificationResponseQueryPolicy;
  public readonly webSocketSubscription: WebSocketSubscriptionPolicy;

  public constructor(middleware: AuthorizationMiddleware) {
    this.hostSetup = { authorize: (input) => middleware.authorizeHost(input) };
    this.memberSnapshot = { authorize: (input) => middleware.authorizeMember(input) };
    this.memberMutation = { authorize: (input) => middleware.authorizeMemberMutation(input) };
    this.leaderboard = { authorize: (input) => middleware.authorizeMember(input) };
    this.resumableAccess = { authorize: (input) => middleware.authorizeResumable(input) };
    this.verificationResponse = {
      authorize: (input) => middleware.authorizeVerificationResponse(input),
    };
    this.webSocketSubscription = {
      authorize: (input) => middleware.authorizeWebSocketSubscriber(input),
    };
  }
}
