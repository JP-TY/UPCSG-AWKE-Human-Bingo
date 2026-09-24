export {
  readEnvironment,
  redactEnvironment,
  EnvironmentValidationError,
} from './config/environment.js';
export type { Environment } from './config/environment.js';
export {
  SessionService,
  credentialHash,
  parseCookieHeader,
  serializeSessionCookie,
  sessionCookieNames,
} from './access/session-service.js';
export type {
  AccessClock,
  AccessRepository,
  AuthenticatedSession,
  CreateBrowserSessionInput,
  CreateMembershipSessionInput,
  MembershipAccessResult,
  RotateBrowserSessionInput,
  SessionAccessResult,
  SessionCookie,
  SessionServiceOptions,
} from './access/session-service.js';
export { AuthorizationMiddleware, ScopedQueryPolicies } from './access/authorization.js';
export { SqlAccessRepository } from './access/sql-access-repository.js';
export { SqlAuthorizationRepository } from './access/sql-authorization-repository.js';
export type {
  AuthorizationRepository,
  AuthorizationPrincipal,
  GameAuthorizationInput,
  HostAuthorization,
  HostSetupQueryPolicy,
  LeaderboardQueryPolicy,
  MemberAuthorization,
  MemberMutationQueryPolicy,
  MemberSnapshotQueryPolicy,
  ResumableAccessQueryPolicy,
  ResumableAuthorizationInput,
  VerificationResponseAuthorization,
  VerificationResponseAuthorizationInput,
  VerificationResponseQueryPolicy,
  WebSocketSubscriptionAuthorization,
  WebSocketSubscriptionPolicy,
} from './access/authorization.js';
export { GameConfigurationService } from './game-configuration.js';
export {
  InvitationService,
  decodeQrPayload,
  encodeQrPayload,
  generateJoinCode,
  hashInvitationToken,
  tokenFromCanonicalLink,
} from './invitation.js';
export { mergeSecurityHeaders, securityHeaders } from './security-headers.js';
export type { SecurityHeaderOptions } from './security-headers.js';
export {
  assertByteLength,
  assertRequestBodySize,
  assertParameterizedQuery,
  defaultInputLimits,
  InMemoryRateLimiter,
  OriginPolicy,
  rateLimitedError,
  SecurityValidationError,
  validateInputLimits,
} from './security.js';
export type {
  CorsHeaders,
  InputLimits,
  RateLimitDecision,
  RateLimiterOptions,
} from './security.js';
export {
  DEFAULT_MAX_EVENT_BYTES,
  defaultReconnectBackoff,
  encodeBoundedRealtimeEvent,
  HeartbeatMonitor,
  reconnectDelay,
  RealtimeGateway,
  RealtimeOrderingError,
  RealtimePayloadError,
  RealtimeProtocolError,
} from './realtime.js';
export type {
  HeartbeatOptions,
  HeartbeatStatus,
  ReconnectBackoffOptions,
  RealtimeConnection,
  RealtimeConnectionRequest,
  RealtimeGatewayOptions,
  RealtimeSessionAuthenticator,
  RealtimeSocket,
} from './realtime.js';
export type { GameConfigurationServiceOptions, LockTaskBagCommand } from './game-configuration.js';
export type { InvitationServiceOptions } from './invitation.js';
export { VerificationCompletionService, VerificationService } from './verification.js';
export { hashEndpoint, InMemoryPushSubscriptionStore, PushNotificationService } from './push.js';
export type {
  PushDeliveryOptions,
  PushDeliveryReport,
  PushProvider,
  PushSubscriptionActor,
  PushSubscriptionAuthorization,
  PushSubscriptionStore,
  VerificationPushDeliveryInput,
} from './push.js';
export type {
  VerificationActor,
  VerificationPushNotifier,
  VerificationServiceOptions,
} from './verification.js';
export {
  HealthService,
  InMemoryAuditSink,
  InMemoryMetrics,
  createObservability,
  createStructuredLogger,
  observeCommand,
  observeRequest,
  recordAuthorizationDenial,
  recordEventDelivery,
  recordPushFailure,
  recordSynchronization,
  reportSafeError,
  sanitizeLogContext,
  toSafeErrorReport,
} from './observability.js';
export type {
  AuditSink,
  AuthorizationDenialAuditEvent,
  CommandObservation,
  HealthCheck,
  HealthCheckResult,
  HealthReport,
  LogContext,
  LogSink,
  MetricLabels,
  MetricSnapshot,
  MetricsSink,
  Observability,
  ObservabilityOptions,
  RequestObservation,
  SafeErrorReport,
  StructuredLogRecord,
  StructuredLogger,
} from './observability.js';

/** API/application-service package boundary; routes are added in task 7.1. */
export const apiPackage = '@human-bingo/api';

export { FACE_STAMP_COUNT, faceStampIndexFor } from './chop-bag.js';
export { GridService } from './grid.js';
export type { GenerateGridCommand, GridGenerationResult, GridServiceOptions } from './grid.js';
export { MembershipService } from './membership.js';
export type {
  MembershipServiceOptions,
  MembershipSessionIssuer,
  OnboardingServiceResult,
} from './membership.js';
export { HttpApi } from './http.js';
export type {
  HttpApiDependencies,
  HttpApiOptions,
  InvitationHttpService,
  OnboardingHttpService,
  SnapshotHttpService,
  HostOverviewHttpService,
  PushHttpService,
} from './http.js';
export {
  LeaderboardQueryService,
  projectLeaderboards,
  projectProgressLeaderboard,
} from './leaderboards.js';
export { SqlHostOverviewReader, overviewForHost } from './host-overview.js';
export type { HostOverviewQuery } from './host-overview.js';
export { createApiRuntime } from './runtime.js';
export type { ApiRuntime, ApiRuntimeDependencies, WebSocketUpgradeHandler } from './runtime.js';
