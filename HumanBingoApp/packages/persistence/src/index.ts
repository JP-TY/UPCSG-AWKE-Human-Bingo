export const persistencePackage = '@human-bingo/persistence';

export type {
  BrowserSessionId,
  BrowserSessionRecord,
  CompletionCategory,
  CompletionKey,
  CompletionRecord,
  GameRecord,
  GameStatus,
  GridRecord,
  InvitationRecord,
  MembershipRecord,
  NotificationRecord,
  NotificationStatus,
  OutboxEventRecord,
  ParticipantRecord,
  PlayerProfileRecord,
  PushSubscriptionRecord,
  SquareRecord,
  SquareStatus,
  TaskEntryRecord,
  VerificationRequestRecord,
  VerificationRequestStatus,
  PersistenceModels,
} from './models.js';

export {
  faceStampsDownSql,
  faceStampsMigration,
  faceStampsUpSql,
  initialSchemaMigration,
  initialSchemaDownSql,
  initialSchemaUpSql,
  migrationLedger,
  runMigration,
} from './migrations/index.js';
export type {
  MigrationClient,
  MigrationDefinition,
  MigrationDirection,
} from './migrations/index.js';

export { seedTestData, testSeedSql } from './test-seed.js';
export type { SeedEnvironment } from './test-seed.js';

export {
  GameCreationRepository,
  GameMutationRepository,
  GameRepository,
  IdempotencyRepository,
  OutboxEventRepository,
  TaskEntryRepository,
} from './repositories.js';
export type { GameMutationInput, GameMutationOutput, IdempotencyRecord } from './repositories.js';

export {
  isStaleStateConflict,
  StaleStateConflictError,
  TransactionRollbackError,
  runInTransaction,
  withTransaction,
} from './transaction.js';
export type {
  SqlClient,
  SqlResult,
  SqlTransaction,
  TransactionAttemptContext,
  TransactionIsolationLevel,
  TransactionOptions,
} from './transaction.js';

export { SqlOutboxRepository, SqlEventConsumerReceiptRepository } from './outbox.js';
export type { EventConsumerReceiptStore, OutboxClaimOptions } from './outbox.js';

export {
  GameConfigurationNotFoundError,
  InMemoryGameConfigurationRepository,
  createTaskEntryRecord,
} from './game-configuration.js';
export type {
  CreateGameRecordInput,
  GameConfigurationRepository,
  GameConfigurationState,
  InMemoryGameConfigurationRepositoryOptions,
} from './game-configuration.js';

export {
  emptyVerificationState,
  InMemoryVerificationRepository,
  VerificationGameNotFoundError,
} from './verification.js';
export type {
  InMemoryVerificationRepositoryOptions,
  VerificationRepository,
  VerificationState,
} from './verification.js';

export { GridGameNotFoundError, InMemoryGridRepository, SqlGridRepository } from './grid.js';
export {
  MembershipGameNotFoundError,
  InMemoryMembershipRepository,
  SqlMembershipRepository,
  createMembershipRecord,
  createParticipantRecord,
  createPlayerProfileRecord,
} from './membership.js';
export type {
  MembershipRepository,
  MembershipState,
  InMemoryMembershipRepositoryOptions,
} from './membership.js';
export { AuthoritativeSnapshotRebuilder, SnapshotRebuildError } from './snapshot.js';
export { SqlPushSubscriptionRepository } from './push-subscriptions.js';
export type {
  PushSubscriptionRepository,
  RegisterPushSubscriptionInput,
} from './push-subscriptions.js';

export { InMemoryInvitationRepository } from './invitation.js';
export type {
  CreateInvitationRecordInput,
  InMemoryInvitationRepositoryOptions,
  InvitationGameRecord,
  InvitationRepository,
} from './invitation.js';
export { SqlGameConfigurationRepository } from './sql-game-configuration.js';
export { SqlInvitationRepository } from './sql-invitation.js';
export { SqlVerificationRepository } from './sql-verification.js';
export { withD1Transaction } from './d1-transaction.js';
export type { D1DatabaseLike, D1Result, D1Transaction } from './d1-transaction.js';
export { D1MembershipRepository } from './d1-membership-repository.js';
export type { AuthoritativeSnapshotReader } from './snapshot.js';
export type { GridCreationRepository, GridState, InMemoryGridRepositoryOptions } from './grid.js';
