import { randomUUID } from 'node:crypto';

import {
  DomainErrorCode,
  HumanBingoError,
  type AddTaskEntryCommand,
  type AddTaskEntriesCommand,
  type CorrelationId,
  type CreateGameCommand,
  type CreateInvitationCommand,
  type GetGameSnapshotQuery,
  type GameConfigurationCommand,
  type GameId,
  type HostOverviewDto,
  type IdempotencyKey,
  type InvitationInput,
  type InvitationToken,
  type JoinCode,
  type ListNotificationsQuery,
  type OnboardParticipantCommand,
  type PlayerCode,
  type RegisterPushSubscriptionCommand,
  type RequestVerificationCommand,
  type RespondToVerificationCommand,
  type StateVersion,
  type TaskEntryId,
  type CreateInvitationResult,
  type ResolveInvitationResult,
  type OnboardParticipantResult,
  type GetGameSnapshotResult,
  type RegisterPushSubscriptionResult,
} from '@human-bingo/domain';
import {
  assertRequestBodySize,
  defaultInputLimits,
  SecurityValidationError,
  validateInputLimits,
} from './security.js';
import type { OriginPolicy } from './security.js';
import { mergeSecurityHeaders, securityHeaders } from './security-headers.js';
import {
  parseCookieHeader,
  sessionCookieNames,
  type AuthenticatedSession,
  type MembershipAccessResult,
  type SessionAccessResult,
} from './access/session-service.js';
import type { SessionService } from './access/session-service.js';
import type {
  AuthorizationPrincipal,
  MemberAuthorization,
  ScopedQueryPolicies,
} from './access/authorization.js';
import type { GameConfigurationService } from './game-configuration.js';
import type { VerificationCompletionService } from './verification.js';

export interface InvitationHttpService {
  create(
    command: CreateInvitationCommand,
    options?: { readonly canonicalBaseUrl?: string },
  ): Promise<CreateInvitationResult>;
  resolve(input: {
    readonly correlationId: CorrelationId;
    readonly input: InvitationInput;
  }): Promise<ResolveInvitationResult>;
}

export interface OnboardingHttpService {
  onboard(
    command: OnboardParticipantCommand,
  ): Promise<OnboardParticipantResult & { readonly access: MembershipAccessResult }>;
}

export interface SnapshotHttpService {
  read(
    query: GetGameSnapshotQuery,
    authorization: MemberAuthorization,
  ): Promise<GetGameSnapshotResult>;
}

export interface HostOverviewHttpService {
  read(query: {
    readonly gameId: GameId;
    readonly correlationId: CorrelationId;
  }): Promise<HostOverviewDto>;
}

export interface PushHttpService {
  register(
    command: RegisterPushSubscriptionCommand,
    authorization: MemberAuthorization,
  ): Promise<RegisterPushSubscriptionResult>;
}

export interface HttpApiDependencies {
  readonly sessions: SessionService;
  readonly authorization: ScopedQueryPolicies;
  readonly gameConfiguration: GameConfigurationService;
  readonly invitations: InvitationHttpService;
  readonly onboarding: OnboardingHttpService;
  readonly snapshots: SnapshotHttpService;
  readonly hostOverview: HostOverviewHttpService;
  readonly verification: VerificationCompletionService;
  readonly push: PushHttpService;
  readonly principalForSession: (session: AuthenticatedSession) => Promise<AuthorizationPrincipal>;
  readonly originPolicy?: OriginPolicy;
  /** App origin used for invitation links when the request carries no usable origin. */
  readonly publicAppOrigin?: string;
}

export interface HttpApiOptions {
  readonly maxBodyBytes?: number;
  readonly sessionCookieName?: string;
  readonly csrfHeaderName?: string;
}

/**
 * Framework-neutral HTTP API for the documented browser endpoints. The
 * handler accepts the standard Request type, so it can be mounted in Node's
 * http server, a Fetch-compatible runtime, or a framework adapter without
 * changing authorization or command semantics.
 */
export class HttpApi {
  readonly #dependencies: HttpApiDependencies;
  readonly #maxBodyBytes: number;
  readonly #sessionCookieName: string;
  readonly #csrfHeaderName: string;

  public constructor(dependencies: HttpApiDependencies, options: HttpApiOptions = {}) {
    this.#dependencies = dependencies;
    this.#maxBodyBytes = options.maxBodyBytes ?? defaultInputLimits.requestBytes;
    this.#sessionCookieName = options.sessionCookieName ?? sessionCookieNames.session;
    this.#csrfHeaderName = options.csrfHeaderName ?? 'x-csrf-token';
  }

  public async handle(request: Request): Promise<Response> {
    const correlationId = correlationIdFor(request);
    const url = new URL(request.url);

    try {
      if (request.method === 'OPTIONS') return this.optionsResponse(request, correlationId);
      this.assertOrigin(request, correlationId);
      const result = await this.dispatch(request, url, correlationId);
      return jsonResponse(result.status, result.body, correlationId, result.cookies);
    } catch (error: unknown) {
      return errorResponse(error, correlationId);
    }
  }

  private async dispatch(
    request: Request,
    url: URL,
    correlationId: CorrelationId,
  ): Promise<DispatchResult> {
    const path = url.pathname.replace(/\/$/, '') || '/';

    if (request.method === 'POST' && path === '/api/session') {
      await this.body(request, correlationId);
      const access = await this.#dependencies.sessions.createHostSession(`guest:${randomUUID()}`);
      return {
        status: 201,
        body: { session: access.session, csrfToken: access.csrfToken },
        cookies: sessionCookies(access, this.#dependencies.sessions),
      };
    }

    if (request.method === 'GET' && path === '/api/session') {
      const authenticated = await this.authenticate(request, correlationId);
      const csrfToken = await this.issueCsrfToken(request, correlationId);
      return { status: 200, body: { session: authenticated.session, csrfToken } };
    }

    if (request.method === 'GET' && path.startsWith('/api/invitations/')) {
      const raw = decodePathPart(path.slice('/api/invitations/'.length), correlationId, 'token');
      validateInputLimits({ token: raw });
      return this.resolveInvitation(raw, correlationId);
    }

    if (request.method === 'POST' && path === '/api/invitations/resolve') {
      const body = await this.body(request, correlationId);
      const input = invitationInput(body, correlationId);
      const result = await this.#dependencies.invitations.resolve({ correlationId, input });
      return { status: 200, body: result };
    }

    if (request.method === 'POST' && path === '/api/games') {
      const authenticated = await this.authenticate(request, correlationId);
      await this.requireCsrf(request, authenticated, correlationId);
      const body = await this.body(request, correlationId);
      const idempotencyKey = this.idempotency(request, body, correlationId);
      const command: CreateGameCommand = {
        name: requiredString(body.name, 'name', correlationId),
        correlationId,
        idempotencyKey,
      };
      const result = await this.#dependencies.gameConfiguration.createGame(
        command,
        authenticated.record.accountOrGuestIdentity,
      );
      return { status: 201, body: result };
    }

    const gamePath = /^\/api\/games\/([^/]+)$/.exec(path);
    if (gamePath?.[1] !== undefined && request.method === 'PATCH') {
      const gameId = decodePathPart(gamePath[1], correlationId, 'gameId') as GameId;
      const authenticated = await this.authenticate(request, correlationId);
      await this.authorizeHost(gameId, authenticated, correlationId);
      await this.requireCsrf(request, authenticated, correlationId);
      const body = await this.body(request, correlationId);
      const command = this.gameConfigurationCommand(gameId, body, request, correlationId);
      const result = await this.#dependencies.gameConfiguration.execute(
        command.command,
        command.operation,
      );
      return { status: 200, body: result };
    }

    const hostPath = /^\/api\/games\/([^/]+)\/host$/.exec(path);
    if (hostPath?.[1] !== undefined && request.method === 'GET') {
      const gameId = decodePathPart(hostPath[1], correlationId, 'gameId') as GameId;
      const authenticated = await this.authenticate(request, correlationId);
      await this.authorizeHost(gameId, authenticated, correlationId);
      const result = await this.#dependencies.gameConfiguration.read({ gameId, correlationId });
      const overview = await this.#dependencies.hostOverview.read({ gameId, correlationId });
      return { status: 200, body: { ...result, overview } };
    }

    const hostOverviewPath = /^\/api\/games\/([^/]+)\/host-overview$/.exec(path);
    if (hostOverviewPath?.[1] !== undefined && request.method === 'GET') {
      const gameId = decodePathPart(hostOverviewPath[1], correlationId, 'gameId') as GameId;
      const authenticated = await this.authenticate(request, correlationId);
      await this.authorizeHost(gameId, authenticated, correlationId);
      const overview = await this.#dependencies.hostOverview.read({ gameId, correlationId });
      return { status: 200, body: { overview } };
    }

    const invitationPath = /^\/api\/games\/([^/]+)\/invitation$/.exec(path);
    if (invitationPath?.[1] !== undefined && request.method === 'POST') {
      const gameId = decodePathPart(invitationPath[1], correlationId, 'gameId') as GameId;
      const authenticated = await this.authenticate(request, correlationId);
      await this.authorizeHost(gameId, authenticated, correlationId);
      await this.requireCsrf(request, authenticated, correlationId);
      const idempotencyKey = this.idempotency(request, {}, correlationId);
      const command: CreateInvitationCommand = { gameId, correlationId, idempotencyKey };
      const canonicalBaseUrl = this.invitationCanonicalBaseUrl(request);
      const result = await this.#dependencies.invitations.create(
        command,
        canonicalBaseUrl === undefined ? {} : { canonicalBaseUrl },
      );
      return { status: 200, body: result };
    }

    const onboardingPath = /^\/api\/games\/([^/]+)\/onboarding$/.exec(path);
    if (onboardingPath?.[1] !== undefined && request.method === 'POST') {
      const gameId = decodePathPart(onboardingPath[1], correlationId, 'gameId') as GameId;
      const body = await this.body(request, correlationId);
      const idempotencyKey = this.idempotency(request, body, correlationId);
      const command: OnboardParticipantCommand = {
        gameId,
        input: invitationInput(body, correlationId),
        displayName: requiredString(body.displayName, 'displayName', correlationId),
        correlationId,
        idempotencyKey,
      };
      const result = await this.#dependencies.onboarding.onboard(command);
      if (String(result.onboarding.game.id) !== String(gameId)) {
        throw domainError(
          DomainErrorCode.InvitationInvalid,
          'The invitation does not belong to this game.',
          correlationId,
          404,
        );
      }
      return {
        status: result.onboarding.resumed ? 200 : 201,
        body: { onboarding: result.onboarding },
        cookies: accessCookies(result.access, this.#dependencies.sessions),
      };
    }

    const snapshotPath = /^\/api\/games\/([^/]+)\/snapshot$/.exec(path);
    if (snapshotPath?.[1] !== undefined && request.method === 'GET') {
      const gameId = decodePathPart(snapshotPath[1], correlationId, 'gameId') as GameId;
      const authenticated = await this.authenticate(request, correlationId);
      const authorization = await this.authorizeMember(gameId, authenticated, correlationId);
      const sinceVersion = optionalVersion(url.searchParams.get('since_version'), correlationId);
      const query: GetGameSnapshotQuery = {
        gameId,
        correlationId,
        ...(sinceVersion === undefined ? {} : { sinceVersion }),
      };
      const result = await this.#dependencies.snapshots.read(query, authorization);
      return { status: 200, body: result };
    }

    const notificationsPath = /^\/api\/games\/([^/]+)\/notifications$/.exec(path);
    if (notificationsPath?.[1] !== undefined && request.method === 'GET') {
      const gameId = decodePathPart(notificationsPath[1], correlationId, 'gameId') as GameId;
      const authenticated = await this.authenticate(request, correlationId);
      const authorization = await this.authorizeMember(gameId, authenticated, correlationId);
      const query: ListNotificationsQuery = {
        gameId,
        correlationId,
        ...(url.searchParams.get('include_resolved') === 'true' ? { includeResolved: true } : {}),
      };
      const result = await this.#dependencies.verification.listNotifications(
        query,
        authorization.participantId,
      );
      return { status: 200, body: result };
    }

    const verificationPath = /^\/api\/games\/([^/]+)\/verification-requests$/.exec(path);
    if (verificationPath?.[1] !== undefined && request.method === 'POST') {
      const gameId = decodePathPart(verificationPath[1], correlationId, 'gameId') as GameId;
      const authenticated = await this.authenticate(request, correlationId);
      const authorization = await this.authorizeMemberMutation(
        gameId,
        authenticated,
        correlationId,
      );
      await this.requireCsrf(request, authenticated, correlationId);
      const body = await this.body(request, correlationId);
      const knownStateVersion = this.knownStateVersion(request, body, correlationId);
      const idempotencyKey = this.idempotency(request, body, correlationId);
      const command: RequestVerificationCommand = {
        gameId,
        gridId: requiredString(
          body.gridId,
          'gridId',
          correlationId,
        ) as RequestVerificationCommand['gridId'],
        squareIndex: requiredInteger(body.squareIndex, 'squareIndex', correlationId),
        identifiedPlayerCode: requiredString(
          body.identifiedPlayerCode,
          'identifiedPlayerCode',
          correlationId,
        ) as PlayerCode,
        knownStateVersion,
        correlationId,
        idempotencyKey,
      };
      const result = await this.#dependencies.verification.request(
        command,
        authorization.participantId,
      );
      return { status: 201, body: result };
    }

    const responsePath = /^\/api\/verification-requests\/([^/]+)\/(confirm|reject)$/.exec(path);
    if (
      responsePath?.[1] !== undefined &&
      responsePath[2] !== undefined &&
      request.method === 'POST'
    ) {
      const requestId = decodePathPart(
        responsePath[1],
        correlationId,
        'verificationRequestId',
      ) as RespondToVerificationCommand['verificationRequestId'];
      const authenticated = await this.authenticate(request, correlationId);
      const body = await this.body(request, correlationId);
      const knownStateVersion = this.knownStateVersion(request, body, correlationId);
      const idempotencyKey = this.idempotency(request, body, correlationId);
      const gameId = requiredString(body.gameId, 'gameId', correlationId) as GameId;
      const authorization =
        this.#dependencies.authorization.verificationResponse === undefined
          ? await this.authorizeMemberMutation(gameId, authenticated, correlationId)
          : await this.authorizeVerificationResponse(
              gameId,
              requestId,
              authenticated,
              correlationId,
            );
      await this.requireCsrf(request, authenticated, correlationId);
      const command: RespondToVerificationCommand = {
        gameId,
        verificationRequestId: requestId,
        decision: responsePath[2] === 'confirm' ? 'confirm' : 'reject',
        knownStateVersion,
        correlationId,
        idempotencyKey,
      };
      const result = await this.#dependencies.verification.respond(
        command,
        authorization.participantId,
      );
      return { status: 200, body: result };
    }

    const pushPath = /^\/api\/games\/([^/]+)\/push-subscriptions$/.exec(path);
    if (
      (pushPath?.[1] !== undefined || path === '/api/push-subscriptions') &&
      request.method === 'POST'
    ) {
      const authenticated = await this.authenticate(request, correlationId);
      const body = await this.body(request, correlationId);
      const gameId = (
        pushPath?.[1] === undefined
          ? requiredString(body.gameId, 'gameId', correlationId)
          : decodePathPart(pushPath[1], correlationId, 'gameId')
      ) as GameId;
      const authorization = await this.authorizeMemberMutation(
        gameId,
        authenticated,
        correlationId,
      );
      await this.requireCsrf(request, authenticated, correlationId);
      const idempotencyKey = this.idempotency(request, body, correlationId);
      const subscription = body.subscription;
      if (!isRecord(subscription)) {
        throw domainError(
          DomainErrorCode.ValidationError,
          'Push subscription is required.',
          correlationId,
          422,
        );
      }
      const command: RegisterPushSubscriptionCommand = {
        gameId,
        correlationId,
        idempotencyKey,
        subscription: {
          endpoint: requiredString(subscription.endpoint, 'subscription.endpoint', correlationId),
          p256dh: requiredString(subscription.p256dh, 'subscription.p256dh', correlationId),
          auth: requiredString(subscription.auth, 'subscription.auth', correlationId),
        },
      };
      const result = await this.#dependencies.push.register(command, authorization);
      return { status: 201, body: result };
    }

    throw domainError(
      DomainErrorCode.NotFound,
      'The requested API route was not found.',
      correlationId,
      404,
    );
  }

  private resolveInvitation(raw: string, correlationId: CorrelationId): Promise<DispatchResult> {
    const input: InvitationInput = /^[A-Z0-9]{6}$/.test(raw)
      ? { joinCode: raw as JoinCode }
      : { token: raw as InvitationToken };
    return this.#dependencies.invitations.resolve({ correlationId, input }).then((result) => ({
      status: 200,
      body: result,
    }));
  }

  private gameConfigurationCommand(
    gameId: GameId,
    body: Record<string, unknown>,
    request: Request,
    correlationId: CorrelationId,
  ): { readonly command: GameConfigurationCommand; readonly operation?: 'open' | 'close' } {
    const action = requiredString(body.action, 'action', correlationId);
    const knownStateVersion = this.knownStateVersion(request, body, correlationId);
    const idempotencyKey = this.idempotency(request, body, correlationId);
    const base = { gameId, knownStateVersion, idempotencyKey, correlationId };
    switch (action) {
      case 'rename':
        return { command: { ...base, name: requiredString(body.name, 'name', correlationId) } };
      case 'add_task':
        return {
          command: {
            ...base,
            text: requiredString(body.text, 'text', correlationId),
          } as AddTaskEntryCommand,
        };
      case 'add_tasks':
        return {
          command: {
            ...base,
            texts: requiredStringArray(body.texts, 'texts', correlationId),
          } as AddTaskEntriesCommand,
        };
      case 'edit_task':
        return {
          command: {
            ...base,
            taskEntryId: requiredString(
              body.taskEntryId,
              'taskEntryId',
              correlationId,
            ) as TaskEntryId,
            text: requiredString(body.text, 'text', correlationId),
          },
        };
      case 'remove_task':
        return {
          command: {
            ...base,
            taskEntryId: requiredString(
              body.taskEntryId,
              'taskEntryId',
              correlationId,
            ) as TaskEntryId,
          },
        };
      case 'open':
        return { command: base, operation: 'open' };
      case 'close':
        return { command: base, operation: 'close' };
      default:
        throw domainError(
          DomainErrorCode.ValidationError,
          'Unsupported game action.',
          correlationId,
          422,
        );
    }
  }

  private async authenticate(
    request: Request,
    correlationId: CorrelationId,
  ): Promise<AuthenticatedSession> {
    const credential = parseCookieHeader(
      request.headers.get('cookie') ?? undefined,
      this.#sessionCookieName,
    );
    if (credential === null) {
      throw domainError(
        DomainErrorCode.Unauthorized,
        'Authentication is required.',
        correlationId,
        401,
      );
    }
    try {
      return await this.#dependencies.sessions.authenticateSession(credential);
    } catch (error: unknown) {
      throw withCorrelation(error, correlationId);
    }
  }

  private async issueCsrfToken(request: Request, correlationId: CorrelationId): Promise<string> {
    const credential = parseCookieHeader(
      request.headers.get('cookie') ?? undefined,
      this.#sessionCookieName,
    );
    if (credential === null) {
      throw domainError(
        DomainErrorCode.Unauthorized,
        'Authentication is required.',
        correlationId,
        401,
      );
    }
    try {
      return await this.#dependencies.sessions.issueCsrfToken(credential);
    } catch (error: unknown) {
      throw withCorrelation(error, correlationId);
    }
  }

  private async authorizeHost(
    gameId: GameId,
    authenticated: AuthenticatedSession,
    correlationId: CorrelationId,
  ): Promise<void> {
    const principal = await this.#dependencies.principalForSession(authenticated);
    try {
      await this.#dependencies.authorization.hostSetup.authorize({ gameId, principal });
    } catch (error: unknown) {
      throw withCorrelation(error, correlationId);
    }
  }

  private async authorizeMember(
    gameId: GameId,
    authenticated: AuthenticatedSession,
    correlationId: CorrelationId,
  ): Promise<MemberAuthorization> {
    const principal = await this.#dependencies.principalForSession(authenticated);
    try {
      return await this.#dependencies.authorization.memberSnapshot.authorize({ gameId, principal });
    } catch (error: unknown) {
      throw withCorrelation(error, correlationId);
    }
  }

  private async authorizeMemberMutation(
    gameId: GameId,
    authenticated: AuthenticatedSession,
    correlationId: CorrelationId,
  ): Promise<MemberAuthorization> {
    const principal = await this.#dependencies.principalForSession(authenticated);
    try {
      const policy = this.#dependencies.authorization.memberMutation;
      return await (policy === undefined
        ? this.#dependencies.authorization.memberSnapshot.authorize({ gameId, principal })
        : policy.authorize({ gameId, principal }));
    } catch (error: unknown) {
      throw withCorrelation(error, correlationId);
    }
  }

  private async authorizeVerificationResponse(
    gameId: GameId,
    verificationRequestId: RespondToVerificationCommand['verificationRequestId'],
    authenticated: AuthenticatedSession,
    correlationId: CorrelationId,
  ): Promise<MemberAuthorization> {
    const principal = await this.#dependencies.principalForSession(authenticated);
    try {
      const authorization = this.#dependencies.authorization.verificationResponse;
      if (authorization === undefined) {
        return await this.authorizeMemberMutation(gameId, authenticated, correlationId);
      }
      return await authorization.authorize({ gameId, principal, verificationRequestId });
    } catch (error: unknown) {
      throw withCorrelation(error, correlationId);
    }
  }

  private async requireCsrf(
    request: Request,
    authenticated: AuthenticatedSession,
    correlationId: CorrelationId,
  ): Promise<void> {
    const credential = parseCookieHeader(
      request.headers.get('cookie') ?? undefined,
      this.#sessionCookieName,
    );
    const csrf = request.headers.get(this.#csrfHeaderName);
    if (credential === null || csrf === null || csrf.trim().length === 0) {
      throw domainError(DomainErrorCode.Forbidden, 'CSRF validation failed.', correlationId, 403);
    }
    try {
      await this.#dependencies.sessions.validateCsrfToken(credential, csrf);
    } catch (error: unknown) {
      throw withCorrelation(error, correlationId);
    }
    // Keep this parameter in the method contract to ensure the token is always
    // checked against the same authenticated session used by the route.
    void authenticated;
  }

  private knownStateVersion(
    request: Request,
    body: Record<string, unknown>,
    correlationId: CorrelationId,
  ): StateVersion {
    const candidate = body.knownStateVersion ?? request.headers.get('if-match');
    if (typeof candidate === 'string' && /^"?\d+"?$/.test(candidate)) {
      return Number(candidate.replaceAll('"', '')) as StateVersion;
    }
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0) {
      return candidate as StateVersion;
    }
    throw domainError(
      DomainErrorCode.ValidationError,
      'knownStateVersion is required.',
      correlationId,
      422,
    );
  }

  private idempotency(
    request: Request,
    body: Record<string, unknown>,
    correlationId: CorrelationId,
  ): IdempotencyKey {
    const value = request.headers.get('idempotency-key') ?? body.idempotencyKey;
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw domainError(
        DomainErrorCode.ValidationError,
        'Idempotency-Key is required.',
        correlationId,
        422,
      );
    }
    validateInputLimits({ idempotencyKey: value });
    return value.trim() as IdempotencyKey;
  }

  private async body(
    request: Request,
    correlationId: CorrelationId,
  ): Promise<Record<string, unknown>> {
    const text = await request.text();
    try {
      assertRequestBodySize(text, this.#maxBodyBytes);
      if (text.trim().length === 0) return {};
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) throw new Error('JSON body must be an object');
      validateInputLimits({
        name: stringValue(parsed.name),
        text: stringValue(parsed.text),
        displayName: stringValue(parsed.displayName),
        playerCode: stringValue(parsed.identifiedPlayerCode),
        token: stringValue(parsed.token),
      });
      return parsed;
    } catch (error: unknown) {
      if (error instanceof SecurityValidationError) {
        throw domainError(DomainErrorCode.ValidationError, error.message, correlationId, 422);
      }
      throw domainError(
        DomainErrorCode.ValidationError,
        'Request body must be valid JSON.',
        correlationId,
        400,
      );
    }
  }

  private assertOrigin(request: Request, correlationId: CorrelationId): void {
    const origin = request.headers.get('origin') ?? undefined;
    if (
      this.#dependencies.originPolicy !== undefined &&
      request.method !== 'GET' &&
      !this.#dependencies.originPolicy.allows(origin)
    ) {
      throw domainError(
        DomainErrorCode.Forbidden,
        'Request origin is not allowed.',
        correlationId,
        403,
      );
    }
  }

  /**
   * Derives the canonical base URL for invitation links. The browser's own
   * request origin is the most accurate app origin (the host's server may be
   * proxied or the API may live on another host); the configured public app
   * origin covers non-browser clients such as API tests.
   */
  private invitationCanonicalBaseUrl(request: Request): string | undefined {
    const configured = process.env.INVITATION_CANONICAL_BASE_URL?.trim();
    if (configured !== undefined && configured !== '') {
      return configured.replace(/\/$/, '');
    }
    const origin = request.headers.get('origin')?.trim();
    if (origin !== undefined && origin !== '' && origin !== 'null') {
      try {
        const parsed = new URL(origin);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          return parsed.toString().replace(/\/$/, '');
        }
      } catch {
        // Fall through to the configured origin.
      }
    }
    const publicOrigin = this.#dependencies.publicAppOrigin?.trim();
    if (publicOrigin === undefined || publicOrigin === '') return undefined;
    return publicOrigin.replace(/\/$/, '');
  }

  private optionsResponse(request: Request, correlationId: CorrelationId): Response {
    const cors = this.#dependencies.originPolicy?.headers(
      request.headers.get('origin') ?? undefined,
    );
    const responseHeaders = securityHeaders();
    if (cors !== null && cors !== undefined) {
      for (const [name, value] of Object.entries(cors) as Array<[string, string]>)
        responseHeaders.set(name, value);
    }
    responseHeaders.set('allow', 'GET,POST,PATCH,OPTIONS');
    responseHeaders.set('access-control-allow-methods', 'GET,POST,PATCH,OPTIONS');
    responseHeaders.set(
      'access-control-allow-headers',
      'content-type,csrf-token,x-csrf-token,idempotency-key,if-match',
    );
    responseHeaders.set('x-correlation-id', correlationId);
    return new Response(null, { status: 204, headers: responseHeaders });
  }
}

interface DispatchResult {
  readonly status?: number;
  readonly body: unknown;
  readonly cookies?: readonly string[];
}

const accessCookies = (
  access: MembershipAccessResult,
  sessions: SessionService,
): readonly string[] => [
  sessions.sessionCookieHeader(access.sessionCookie),
  sessions.sessionCookieHeader(access.csrfCookie),
  sessions.sessionCookieHeader(access.resumableCookie),
];

const sessionCookies = (
  access: SessionAccessResult,
  sessions: SessionService,
): readonly string[] => [
  sessions.sessionCookieHeader(access.sessionCookie),
  sessions.sessionCookieHeader(access.csrfCookie),
];

const correlationIdFor = (request: Request): CorrelationId => {
  const supplied = request.headers.get('x-correlation-id')?.trim();
  return supplied !== undefined && supplied.length > 0 && supplied.length <= 128
    ? (supplied as CorrelationId)
    : (randomUUID() as CorrelationId);
};

const jsonResponse = (
  status: number | undefined,
  value: unknown,
  correlationId: CorrelationId,
  cookies?: readonly string[],
): Response => {
  const headers = mergeSecurityHeaders(
    new Headers({
      'content-type': 'application/json; charset=utf-8',
      'x-correlation-id': correlationId,
      'cache-control': 'no-store',
    }),
  );
  for (const cookie of cookies ?? []) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify({ ...asRecord(value), correlationId }), {
    status: status ?? 200,
    headers,
  });
};

const errorResponse = (error: unknown, fallbackCorrelationId: CorrelationId): Response => {
  const safe = toHttpError(error, fallbackCorrelationId);
  return new Response(JSON.stringify({ error: safe.toDto() }), {
    status: safe.httpStatus,
    headers: mergeSecurityHeaders(
      new Headers({
        'content-type': 'application/json; charset=utf-8',
        'x-correlation-id': safe.correlationId,
        'cache-control': 'no-store',
      }),
    ),
  });
};

const toHttpError = (error: unknown, correlationId: CorrelationId): HumanBingoError => {
  if (error instanceof HumanBingoError) return error;
  if (error instanceof SecurityValidationError) {
    return domainError(DomainErrorCode.ValidationError, error.message, correlationId, 422);
  }
  return domainError(
    DomainErrorCode.InvalidCommand,
    'The request could not be completed.',
    correlationId,
    400,
  );
};

const withCorrelation = (error: unknown, correlationId: CorrelationId): HumanBingoError => {
  if (!(error instanceof HumanBingoError)) return toHttpError(error, correlationId);
  if (error.correlationId === correlationId) return error;
  return new HumanBingoError({
    code: error.code,
    message: error.message,
    correlationId,
    retryable: error.retryable,
    httpStatus: error.httpStatus,
    ...(error.fieldErrors === undefined ? {} : { fieldErrors: error.fieldErrors }),
    ...(error.metadata === undefined ? {} : { metadata: error.metadata }),
  });
};

const domainError = (
  code: DomainErrorCode,
  message: string,
  correlationId: CorrelationId,
  httpStatus: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503,
): HumanBingoError =>
  new HumanBingoError({
    code,
    message,
    correlationId,
    retryable: false,
    httpStatus,
  });

const requiredString = (value: unknown, field: string, correlationId: CorrelationId): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw domainError(DomainErrorCode.ValidationError, `${field} is required.`, correlationId, 422);
  }
  return value;
};

const requiredStringArray = (
  value: unknown,
  field: string,
  correlationId: CorrelationId,
): readonly string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw domainError(
      DomainErrorCode.ValidationError,
      `${field} must contain between 1 and 100 items.`,
      correlationId,
      422,
    );
  }
  if (value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw domainError(
      DomainErrorCode.ValidationError,
      `${field} must contain non-empty strings.`,
      correlationId,
      422,
    );
  }
  return value as string[];
};

const requiredInteger = (value: unknown, field: string, correlationId: CorrelationId): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw domainError(
      DomainErrorCode.ValidationError,
      `${field} must be an integer.`,
      correlationId,
      422,
    );
  }
  return value;
};

const optionalVersion = (
  value: string | null,
  correlationId: CorrelationId,
): StateVersion | undefined => {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value))
    throw domainError(
      DomainErrorCode.ValidationError,
      'since_version must be an integer.',
      correlationId,
      422,
    );
  return Number(value) as StateVersion;
};

const invitationInput = (
  body: Record<string, unknown>,
  correlationId: CorrelationId,
): InvitationInput => {
  const joinCode = body.joinCode;
  const token = body.token;
  if (typeof joinCode === 'string' && /^[A-Z0-9]{6}$/.test(joinCode))
    return { joinCode: joinCode as JoinCode };
  if (typeof token === 'string' && token.trim().length > 0)
    return { token: token.trim() as InvitationToken };
  throw domainError(
    DomainErrorCode.InvitationInvalid,
    'A valid invitation code or token is required.',
    correlationId,
    422,
  );
};

const decodePathPart = (value: string, correlationId: CorrelationId, field: string): string => {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.length === 0) throw new Error('empty');
    return decoded;
  } catch {
    throw domainError(DomainErrorCode.ValidationError, `${field} is invalid.`, correlationId, 422);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : { value });
const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
