/**
 * Shared contracts for the Human Bingo application.
 *
 * This package is deliberately transport- and persistence-agnostic. DTOs contain
 * only data that an authorized recipient may render; session, invitation, and
 * push credentials are never represented in response DTOs.
 */

// ---------------------------------------------------------------------------
// Branded primitives
// ---------------------------------------------------------------------------

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type GameId = Brand<string, 'GameId'>;
export type TaskEntryId = Brand<string, 'TaskEntryId'>;
export type InvitationId = Brand<string, 'InvitationId'>;
export type BrowserSessionId = Brand<string, 'BrowserSessionId'>;
export type MembershipId = Brand<string, 'MembershipId'>;
export type ParticipantId = Brand<string, 'ParticipantId'>;
export type PlayerProfileId = Brand<string, 'PlayerProfileId'>;
export type GridId = Brand<string, 'GridId'>;
export type VerificationRequestId = Brand<string, 'VerificationRequestId'>;
export type NotificationId = Brand<string, 'NotificationId'>;
export type PushSubscriptionId = Brand<string, 'PushSubscriptionId'>;
export type CompletionId = Brand<string, 'CompletionId'>;
export type OutboxEventId = Brand<string, 'OutboxEventId'>;
export type CorrelationId = Brand<string, 'CorrelationId'>;
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>;
export type InvitationToken = Brand<string, 'InvitationToken'>;
export type JoinCode = Brand<string, 'JoinCode'>;
export type PlayerCode = Brand<string, 'PlayerCode'>;
export type StateVersion = Brand<number, 'StateVersion'>;
export type Timestamp = Brand<string, 'Timestamp'>;

/** Alias used by callers that want to make the wire format explicit. */
export type IsoTimestamp = Timestamp;

// ---------------------------------------------------------------------------
// Domain enums and scalar unions
// ---------------------------------------------------------------------------

export enum GameStatus {
  Draft = 'draft',
  InvitationAvailable = 'invitation_available',
  Active = 'active',
  Closed = 'closed',
}

export type GameLifecycleStatus = GameStatus;

export enum SquareStatus {
  Unverified = 'unverified',
  Pending = 'pending',
  Rejected = 'rejected',
  Verified = 'verified',
}

export enum VerificationRequestStatus {
  Pending = 'pending',
  Confirmed = 'confirmed',
  Rejected = 'rejected',
}

export enum NotificationStatus {
  Pending = 'pending',
  Resolved = 'resolved',
}

export enum InvitationStatus {
  Available = 'available',
  Revoked = 'revoked',
  Expired = 'expired',
  Closed = 'closed',
}

export enum CompletionCategory {
  Blackout = 'blackout',
  Line = 'line',
  Hashtag = 'hashtag',
}

export enum LineDirection {
  Horizontal = 'horizontal',
  Vertical = 'vertical',
  Diagonal = 'diagonal',
}

export type DiagonalPosition = 'top_left_to_bottom_right' | 'top_right_to_bottom_left';
export type LinePosition =
  | { readonly direction: LineDirection.Horizontal; readonly position: 1 | 2 | 3 | 4 | 5 }
  | { readonly direction: LineDirection.Vertical; readonly position: 1 | 2 | 3 | 4 | 5 }
  | { readonly direction: LineDirection.Diagonal; readonly position: DiagonalPosition };

export type CompletionKey =
  | 'blackout'
  | 'hashtag'
  | `horizontal:${1 | 2 | 3 | 4 | 5}`
  | `vertical:${1 | 2 | 3 | 4 | 5}`
  | 'diagonal:top_left_to_bottom_right'
  | 'diagonal:top_right_to_bottom_left';

export type VerificationDecision = 'confirm' | 'reject';
export type InvitationInput = { readonly joinCode: JoinCode } | { readonly token: InvitationToken };

// ---------------------------------------------------------------------------
// Authorization-safe entity DTOs
// ---------------------------------------------------------------------------

/** Game data safe for an authorized member; host account/session details are omitted. */
export interface GameDto {
  readonly id: GameId;
  readonly name: string;
  readonly status: GameStatus;
  readonly distinctTaskCount: number;
  readonly taskBagLocked: boolean;
  readonly stateVersion: StateVersion;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly closedAt?: Timestamp;
}

export interface TaskEntryDto {
  readonly id: TaskEntryId;
  readonly text: string;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface InvitationRepresentationDto {
  readonly invitationId: InvitationId;
  readonly gameId: GameId;
  readonly joinCode: JoinCode;
  readonly canonicalLink: string;
  /** Encoded canonical link; QR image generation remains a presentation concern. */
  readonly qrPayload: string;
  readonly status: InvitationStatus;
  readonly expiresAt?: Timestamp;
}

/** Public resolution preview. It does not create or identify a membership. */
export interface InvitationPreviewDto {
  readonly gameId: GameId;
  readonly gameName: string;
  readonly gameStatus: GameStatus;
  readonly invitationStatus: InvitationStatus;
  readonly joinCode: JoinCode;
  readonly expiresAt?: Timestamp;
}

export interface ParticipantIdentityDto {
  readonly participantId: ParticipantId;
  readonly displayName: string;
  readonly playerCode: PlayerCode;
}

export interface ParticipantDto {
  readonly id: ParticipantId;
  readonly displayName: string;
  readonly joinedAt: Timestamp;
}

export interface PlayerProfileDto {
  readonly id: PlayerProfileId;
  readonly participantId: ParticipantId;
  readonly displayName: string;
  readonly playerCode: PlayerCode;
  readonly createdAt: Timestamp;
}

/** Membership DTO intentionally excludes resumable credentials and cookies. */
export interface MembershipDto {
  readonly id: MembershipId;
  readonly gameId: GameId;
  readonly participantId: ParticipantId;
  readonly createdAt: Timestamp;
  readonly lastSeenAt: Timestamp;
}

/** Session metadata is safe to return; the raw session credential is not. */
export interface BrowserSessionDto {
  readonly id: BrowserSessionId;
  readonly membershipId?: MembershipId;
  readonly expiresAt: Timestamp;
  readonly authorizationVersion: number;
}

export interface GridSquareDto {
  readonly gridId: GridId;
  readonly squareIndex: number;
  readonly row: 1 | 2 | 3 | 4 | 5;
  readonly column: 1 | 2 | 3 | 4 | 5;
  readonly taskEntryId: TaskEntryId;
  readonly taskText: string;
  readonly status: SquareStatus;
  /** Face-stamp selection persisted when the square becomes verified. */
  readonly stampIndex?: number;
  readonly updatedAt: Timestamp;
}

export interface GridDto {
  readonly id: GridId;
  readonly gameId: GameId;
  readonly participantId: ParticipantId;
  readonly squares: readonly GridSquareDto[];
  readonly taskBagVersion: StateVersion;
  readonly stateVersion: StateVersion;
  readonly createdAt: Timestamp;
}

export interface VerificationRequestDto {
  readonly id: VerificationRequestId;
  readonly gameId: GameId;
  readonly gridId: GridId;
  readonly squareIndex: number;
  readonly taskText: string;
  readonly requestingParticipant: ParticipantIdentityDto;
  readonly identifiedParticipant: ParticipantIdentityDto;
  readonly status: VerificationRequestStatus;
  readonly createdAt: Timestamp;
  readonly resolvedAt?: Timestamp;
  readonly outcomeActorId?: ParticipantId;
  readonly decision?: VerificationDecision;
}

export interface NotificationDto {
  readonly id: NotificationId;
  readonly gameId: GameId;
  readonly recipientParticipantId: ParticipantId;
  readonly verificationRequestId: VerificationRequestId;
  readonly kind: 'verification_request';
  readonly status: NotificationStatus;
  readonly gameName: string;
  readonly requestingParticipant: ParticipantIdentityDto;
  readonly taskText: string;
  readonly createdAt: Timestamp;
  readonly resolvedAt?: Timestamp;
}

export interface CompletionDto {
  readonly id: CompletionId;
  readonly gameId: GameId;
  readonly participantId: ParticipantId;
  readonly playerCode: PlayerCode;
  readonly category: CompletionCategory;
  readonly completionKey: CompletionKey;
  readonly completedAt: Timestamp;
}

export interface BlackoutLeaderboardEntryDto {
  readonly participant: ParticipantIdentityDto;
  readonly completionCount: number;
  readonly earliestCompletionAt: Timestamp;
  readonly completions: readonly CompletionDto[];
}

export interface LineLeaderboardEntryDto {
  readonly participant: ParticipantIdentityDto;
  readonly completionCount: number;
  readonly earliestCompletionAt: Timestamp;
  readonly completions: readonly CompletionDto[];
}

export interface HashtagLeaderboardEntryDto {
  readonly participant: ParticipantIdentityDto;
  readonly completionCount: number;
  readonly earliestCompletionAt: Timestamp;
  readonly completions: readonly CompletionDto[];
}

export interface BlackoutLeaderboardDto {
  readonly category: CompletionCategory.Blackout;
  readonly totalCompletions: number;
  readonly entries: readonly BlackoutLeaderboardEntryDto[];
}

export interface LineLeaderboardDto {
  readonly category: CompletionCategory.Line;
  readonly entries: readonly LineLeaderboardEntryDto[];
}

export interface HashtagLeaderboardDto {
  readonly category: CompletionCategory.Hashtag;
  readonly totalCompletions: number;
  readonly entries: readonly HashtagLeaderboardEntryDto[];
}

export interface LeaderboardsDto {
  readonly blackout: BlackoutLeaderboardDto;
  readonly line: LineLeaderboardDto;
  readonly hashtag: HashtagLeaderboardDto;
  /** Optional for compatibility with older snapshots; new snapshots include it. */
  readonly progress?: ProgressLeaderboardDto;
}

export interface ProgressLeaderboardEntryDto {
  readonly participant: ParticipantIdentityDto;
  readonly verifiedSquares: number;
  readonly qualifiedLines: number;
  readonly hashtagSquares: number;
  /** Longest single row, column, or diagonal with verified squares so far. */
  readonly bestLine: number;
}

export interface ProgressLeaderboardDto {
  readonly category: 'progress';
  readonly entries: readonly ProgressLeaderboardEntryDto[];
}

/**
 * Game-wide progress for one participant, shown to the host. Counts use the
 * same qualification rules as the member progress summary and completions.
 */
export interface HostParticipantProgressDto {
  readonly participant: ParticipantIdentityDto;
  readonly verifiedSquares: number;
  readonly qualifiedLines: number;
  readonly hashtagSquares: number;
  /** Longest single row, column, or diagonal with verified squares so far. */
  readonly bestLine: number;
  readonly joinedAt: Timestamp;
  readonly lastSeenAt?: Timestamp;
}

/**
 * The host-scoped game overview: active participants with per-participant
 * progress plus game-wide standings. It contains no member-scoped requests or
 * notifications and is only served to a verified host session.
 */
export interface HostOverviewDto {
  readonly gameId: GameId;
  readonly participants: readonly HostParticipantProgressDto[];
  readonly leaderboards: LeaderboardsDto;
  readonly stateVersion: StateVersion;
}

/**
 * The complete member-scoped view. It contains the current participant's grid,
 * game-level standings, and only requests/notifications visible to this member.
 */
export interface GameSnapshotDto {
  readonly game: GameDto;
  readonly tasks: readonly TaskEntryDto[];
  readonly membership: MembershipDto;
  readonly participant: ParticipantDto;
  readonly profile: PlayerProfileDto;
  readonly grid: GridDto;
  readonly verificationRequests: readonly VerificationRequestDto[];
  readonly notifications: readonly NotificationDto[];
  readonly leaderboards: LeaderboardsDto;
  readonly stateVersion: StateVersion;
}

export interface OnboardingResultDto {
  readonly game: GameDto;
  readonly membership: MembershipDto;
  readonly participant: ParticipantDto;
  readonly profile: PlayerProfileDto;
  readonly grid: GridDto;
  readonly resumed: boolean;
  readonly stateVersion: StateVersion;
}

// ---------------------------------------------------------------------------
// Command, query, and result contracts
// ---------------------------------------------------------------------------

export interface RequestMetadata {
  readonly correlationId: CorrelationId;
}

export interface CommandMetadata extends RequestMetadata {
  readonly idempotencyKey: IdempotencyKey;
}

export type QueryMetadata = RequestMetadata;

export interface StateChangingCommandMetadata extends CommandMetadata {
  readonly knownStateVersion: StateVersion;
}

export interface CreateGameCommand extends CommandMetadata {
  readonly name: string;
}

export interface CreateGameResult {
  readonly game: GameDto;
}

export interface RenameGameCommand extends StateChangingCommandMetadata {
  readonly gameId: GameId;
  readonly name: string;
}

export interface AddTaskEntryCommand extends StateChangingCommandMetadata {
  readonly gameId: GameId;
  readonly text: string;
}

export interface AddTaskEntriesCommand extends StateChangingCommandMetadata {
  readonly gameId: GameId;
  readonly texts: readonly string[];
}

export interface EditTaskEntryCommand extends StateChangingCommandMetadata {
  readonly gameId: GameId;
  readonly taskEntryId: TaskEntryId;
  readonly text: string;
}

export interface RemoveTaskEntryCommand extends StateChangingCommandMetadata {
  readonly gameId: GameId;
  readonly taskEntryId: TaskEntryId;
}

export interface OpenGameCommand extends StateChangingCommandMetadata {
  readonly gameId: GameId;
}

export interface CloseGameCommand extends StateChangingCommandMetadata {
  readonly gameId: GameId;
}

export type GameConfigurationCommand =
  | RenameGameCommand
  | AddTaskEntryCommand
  | AddTaskEntriesCommand
  | EditTaskEntryCommand
  | RemoveTaskEntryCommand
  | OpenGameCommand
  | CloseGameCommand;

export interface GameMutationResult {
  readonly game: GameDto;
  readonly tasks: readonly TaskEntryDto[];
  readonly stateVersion: StateVersion;
}

export interface CreateInvitationCommand extends CommandMetadata {
  readonly gameId: GameId;
}

export interface CreateInvitationResult {
  readonly invitation: InvitationRepresentationDto;
}

export interface ResolveInvitationQuery extends QueryMetadata {
  readonly input: InvitationInput;
}

export interface ResolveInvitationResult {
  readonly preview: InvitationPreviewDto;
}

export interface OnboardParticipantCommand extends CommandMetadata {
  readonly gameId?: GameId;
  readonly input: InvitationInput;
  readonly displayName: string;
  /** Stable browser/guest identity; generated by the client and never rendered. */
  readonly participantIdentity?: string;
}

export interface OnboardParticipantResult {
  readonly onboarding: OnboardingResultDto;
}

export interface ResumeMembershipQuery extends QueryMetadata {
  readonly gameId: GameId;
}

export interface ResumeMembershipResult {
  readonly snapshot: GameSnapshotDto;
}

export interface GetGameSnapshotQuery extends QueryMetadata {
  readonly gameId: GameId;
  readonly sinceVersion?: StateVersion;
}

export interface GetGameSnapshotResult {
  readonly snapshot: GameSnapshotDto;
}

export interface GetLeaderboardsQuery extends QueryMetadata {
  readonly gameId: GameId;
}

export interface GetLeaderboardsResult {
  readonly leaderboards: LeaderboardsDto;
  readonly stateVersion: StateVersion;
}

export interface RequestVerificationCommand extends StateChangingCommandMetadata {
  readonly gameId: GameId;
  readonly gridId: GridId;
  readonly squareIndex: number;
  readonly identifiedPlayerCode: PlayerCode;
}

export interface RespondToVerificationCommand extends StateChangingCommandMetadata {
  readonly gameId: GameId;
  readonly verificationRequestId: VerificationRequestId;
  readonly decision: VerificationDecision;
}

export interface VerificationMutationResult {
  readonly request: VerificationRequestDto;
  readonly square: GridSquareDto;
  readonly notifications: readonly NotificationDto[];
  readonly completions: readonly CompletionDto[];
  readonly stateVersion: StateVersion;
}

export interface ListNotificationsQuery extends QueryMetadata {
  readonly gameId: GameId;
  readonly includeResolved?: boolean;
}

export interface ListNotificationsResult {
  readonly notifications: readonly NotificationDto[];
  readonly pendingCount: number;
}

export interface PushSubscriptionRegistration {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export interface RegisterPushSubscriptionCommand extends CommandMetadata {
  readonly gameId: GameId;
  readonly subscription: PushSubscriptionRegistration;
}

export interface RegisterPushSubscriptionResult {
  readonly subscriptionId: PushSubscriptionId;
}

// ---------------------------------------------------------------------------
// Versioned realtime contracts
// ---------------------------------------------------------------------------

export interface PatchChanges {
  readonly game?: GameDto;
  readonly tasks?: readonly TaskEntryDto[];
  readonly squares?: readonly GridSquareDto[];
  readonly verificationRequests?: readonly VerificationRequestDto[];
  readonly notifications?: readonly NotificationDto[];
  readonly completions?: readonly CompletionDto[];
  readonly leaderboards?: Partial<LeaderboardsDto>;
}

export interface GamePatchDto {
  readonly type: 'game.patch';
  readonly gameId: GameId;
  readonly stateVersion: StateVersion;
  readonly previousStateVersion: StateVersion;
  readonly eventId: OutboxEventId;
  readonly changes: PatchChanges;
}

export interface SnapshotRequiredEvent {
  readonly type: 'snapshot_required';
  readonly gameId: GameId;
  readonly expectedStateVersion: StateVersion;
  readonly reason: 'version_gap' | 'reconnect' | 'retention_miss' | 'authorization_changed';
}

export type RealtimeEvent = GamePatchDto | SnapshotRequiredEvent;

export interface SyncState {
  readonly status: 'synchronized' | 'synchronizing' | 'unsynchronized';
  readonly stateVersion?: StateVersion;
  readonly error?: DomainErrorCode;
}

export interface SnapshotSyncResult {
  readonly snapshot: GameSnapshotDto;
  readonly sync: SyncState & {
    readonly status: 'synchronized';
    readonly stateVersion: StateVersion;
  };
}

// ---------------------------------------------------------------------------
// Typed errors and result envelopes
// ---------------------------------------------------------------------------

export enum DomainErrorCode {
  ValidationError = 'VALIDATION_ERROR',
  TaskRequired = 'TASK_REQUIRED',
  DuplicateTask = 'DUPLICATE_TASK',
  InsufficientTasks = 'INSUFFICIENT_TASKS',
  InvitationInvalid = 'INVITATION_INVALID',
  InvitationClosed = 'INVITATION_CLOSED',
  OnboardingRetryable = 'ONBOARDING_RETRYABLE',
  PlayerCodeGenerationFailed = 'PLAYER_CODE_GENERATION_FAILED',
  GridGenerationFailed = 'GRID_GENERATION_FAILED',
  InvalidPlayerCode = 'INVALID_PLAYER_CODE',
  SelfVerification = 'SELF_VERIFICATION',
  RequestAlreadyPending = 'REQUEST_ALREADY_PENDING',
  DuplicateIdentifiedParticipant = 'DUPLICATE_IDENTIFIED_PARTICIPANT',
  NotIdentifiedParticipant = 'NOT_IDENTIFIED_PARTICIPANT',
  StaleState = 'STALE_STATE',
  GameClosed = 'GAME_CLOSED',
  SyncRequired = 'SYNC_REQUIRED',
  SyncFailed = 'SYNC_FAILED',
  Forbidden = 'FORBIDDEN',
  Unauthorized = 'UNAUTHORIZED',
  NotFound = 'NOT_FOUND',
  RateLimited = 'RATE_LIMITED',
  InvalidCommand = 'INVALID_COMMAND',
}

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

export interface DomainErrorDto {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly correlationId: CorrelationId;
  readonly retryable: boolean;
  readonly httpStatus: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503;
  readonly fieldErrors?: readonly FieldError[];
  /** Safe, non-secret metadata such as current state version or task count. */
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface DomainErrorInput {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly correlationId: CorrelationId;
  readonly retryable: boolean;
  readonly httpStatus: DomainErrorDto['httpStatus'];
  readonly fieldErrors?: readonly FieldError[];
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export class HumanBingoError extends Error {
  readonly code: DomainErrorCode;
  readonly correlationId: CorrelationId;
  readonly retryable: boolean;
  readonly httpStatus: DomainErrorDto['httpStatus'];
  readonly fieldErrors?: readonly FieldError[];
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;

  public constructor(input: DomainErrorInput) {
    super(input.message);
    this.name = 'HumanBingoError';
    this.code = input.code;
    this.correlationId = input.correlationId;
    this.retryable = input.retryable;
    this.httpStatus = input.httpStatus;
    if (input.fieldErrors !== undefined) this.fieldErrors = input.fieldErrors;
    if (input.metadata !== undefined) this.metadata = input.metadata;
  }

  public toDto(): DomainErrorDto {
    return {
      code: this.code,
      message: this.message,
      correlationId: this.correlationId,
      retryable: this.retryable,
      httpStatus: this.httpStatus,
      ...(this.fieldErrors === undefined ? {} : { fieldErrors: this.fieldErrors }),
      ...(this.metadata === undefined ? {} : { metadata: this.metadata }),
    };
  }
}

export interface SuccessResult<Value> {
  readonly ok: true;
  readonly value: Value;
  readonly correlationId: CorrelationId;
}

export interface ErrorResult {
  readonly ok: false;
  readonly error: DomainErrorDto;
}

export type Result<Value> = SuccessResult<Value> | ErrorResult;

export type CommandResult<Value> = Result<Value>;
export type QueryResult<Value> = Result<Value>;
