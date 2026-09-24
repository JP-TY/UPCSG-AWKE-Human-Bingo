import type {
  BrowserSessionId as DomainBrowserSessionId,
  CompletionCategory as DomainCompletionCategory,
  CompletionId as DomainCompletionId,
  GameId as DomainGameId,
  GridId as DomainGridId,
  InvitationId as DomainInvitationId,
  MembershipId as DomainMembershipId,
  NotificationId as DomainNotificationId,
  OutboxEventId as DomainOutboxEventId,
  ParticipantId as DomainParticipantId,
  PlayerProfileId as DomainPlayerProfileId,
  PushSubscriptionId as DomainPushSubscriptionId,
  SquareStatus as DomainSquareStatus,
  TaskEntryId as DomainTaskEntryId,
  VerificationRequestId as DomainVerificationRequestId,
  VerificationRequestStatus as DomainVerificationRequestStatus,
  NotificationStatus as DomainNotificationStatus,
  GameStatus as DomainGameStatus,
} from '@human-bingo/domain';

export type GameId = DomainGameId;
export type TaskEntryId = DomainTaskEntryId;
export type InvitationId = DomainInvitationId;
export type BrowserSessionId = DomainBrowserSessionId;
export type MembershipId = DomainMembershipId;
export type ParticipantId = DomainParticipantId;
export type PlayerProfileId = DomainPlayerProfileId;
export type GridId = DomainGridId;
export type VerificationRequestId = DomainVerificationRequestId;
export type NotificationId = DomainNotificationId;
export type PushSubscriptionId = DomainPushSubscriptionId;
export type CompletionId = DomainCompletionId;
export type OutboxEventId = DomainOutboxEventId;

export type GameStatus = DomainGameStatus;
export type SquareStatus = DomainSquareStatus;
export type VerificationRequestStatus = DomainVerificationRequestStatus;
export type NotificationStatus = DomainNotificationStatus;
export type CompletionCategory = DomainCompletionCategory;
export type LineCompletionKey =
  | `row:${1 | 2 | 3 | 4 | 5}`
  | `column:${1 | 2 | 3 | 4 | 5}`
  | 'diag:tlbr'
  | 'diag:trbl';
export type CompletionKey = 'blackout' | 'hashtag' | LineCompletionKey;

export interface GameRecord {
  readonly id: GameId;
  readonly hostAccountId: string;
  readonly name: string;
  readonly status: GameStatus;
  readonly taskBagLockedAt: Date | null;
  readonly closedAt: Date | null;
  readonly stateVersion: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TaskEntryRecord {
  readonly id: TaskEntryId;
  readonly gameId: GameId;
  readonly displayText: string;
  readonly normalizedText: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly removedAt: Date | null;
}

export interface InvitationRecord {
  readonly id: InvitationId;
  readonly gameId: GameId;
  readonly joinCode: string;
  readonly tokenHash: Uint8Array;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export interface BrowserSessionRecord {
  readonly id: BrowserSessionId;
  readonly sessionIdHash: Uint8Array;
  readonly accountOrGuestIdentity: string;
  readonly authorizationVersion: bigint;
  readonly createdAt: Date;
  readonly rotatedAt: Date | null;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface ParticipantRecord {
  readonly id: ParticipantId;
  readonly gameId: GameId;
  readonly createdAt: Date;
  readonly leftAt: Date | null;
}

export interface MembershipRecord {
  readonly id: MembershipId;
  readonly gameId: GameId;
  readonly participantId: ParticipantId;
  /** Stable browser/guest identity used to make onboarding idempotent. */
  readonly identityKey?: string;
  readonly browserSessionId: BrowserSessionId | null;
  readonly resumableCredentialHash: Uint8Array;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
}

export interface PlayerProfileRecord {
  readonly id: PlayerProfileId;
  readonly gameId: GameId;
  readonly participantId: ParticipantId;
  readonly displayName: string | null;
  readonly playerCode: string;
  readonly createdAt: Date;
}

export interface GridRecord {
  readonly id: GridId;
  readonly gameId: GameId;
  readonly participantId: ParticipantId;
  readonly taskBagVersion: bigint;
  readonly stateVersion: bigint;
  readonly createdAt: Date;
}

export interface SquareRecord {
  readonly gridId: GridId;
  readonly gameId: GameId;
  readonly squareIndex: number;
  readonly taskEntryId: TaskEntryId;
  readonly status: SquareStatus;
  /** Null until a verification is confirmed. */
  readonly stampIndex?: number;
  readonly updatedAt: Date;
}

export interface VerificationRequestRecord {
  readonly id: VerificationRequestId;
  readonly gameId: GameId;
  readonly gridId: GridId;
  readonly squareIndex: number;
  readonly requestingParticipantId: ParticipantId;
  readonly identifiedParticipantId: ParticipantId;
  readonly status: VerificationRequestStatus;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
  readonly outcomeActorId: ParticipantId | null;
  readonly clientCommandId: string;
}

export interface NotificationRecord {
  readonly id: NotificationId;
  readonly gameId: GameId;
  readonly recipientParticipantId: ParticipantId;
  readonly verificationRequestId: VerificationRequestId;
  readonly kind: string;
  readonly status: NotificationStatus;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

export interface PushSubscriptionRecord {
  readonly id: PushSubscriptionId;
  readonly gameId: GameId;
  readonly participantId: ParticipantId;
  readonly endpointHash: Uint8Array;
  readonly providerData: Record<string, unknown>;
  readonly createdAt: Date;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface CompletionRecord {
  readonly id: CompletionId;
  readonly gameId: GameId;
  readonly participantId: ParticipantId;
  readonly category: CompletionCategory;
  readonly completionKey: CompletionKey;
  readonly completedAt: Date;
  readonly createdAt: Date;
}

export interface OutboxEventRecord {
  readonly id: OutboxEventId;
  readonly gameId: GameId;
  readonly stateVersion: bigint;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: Date;
  readonly publishedAt: Date | null;
  readonly attemptCount: number;
  readonly nextAttemptAt: Date | null;
  readonly lastError: string | null;
}

export interface PersistenceModels {
  readonly games: GameRecord;
  readonly taskEntries: TaskEntryRecord;
  readonly invitations: InvitationRecord;
  readonly browserSessions: BrowserSessionRecord;
  readonly memberships: MembershipRecord;
  readonly participants: ParticipantRecord;
  readonly playerProfiles: PlayerProfileRecord;
  readonly grids: GridRecord;
  readonly squares: SquareRecord;
  readonly verificationRequests: VerificationRequestRecord;
  readonly notifications: NotificationRecord;
  readonly pushSubscriptions: PushSubscriptionRecord;
  readonly completions: CompletionRecord;
  readonly outboxEvents: OutboxEventRecord;
}
