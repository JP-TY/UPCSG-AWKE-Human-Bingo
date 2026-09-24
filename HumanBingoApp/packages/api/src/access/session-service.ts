import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  BrowserSessionDto,
  BrowserSessionId,
  CorrelationId,
  DomainErrorCode,
  MembershipDto,
  MembershipId,
  Timestamp,
} from '@human-bingo/domain';
import { DomainErrorCode as ErrorCode, HumanBingoError } from '@human-bingo/domain';
import { recordAuthorizationDenial } from '../observability.js';
import type { Observability } from '../observability.js';
import type {
  BrowserSessionRecord,
  MembershipRecord,
  SqlTransaction,
} from '@human-bingo/persistence';

const DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 * 24;
const DEFAULT_SESSION_COOKIE = '__Host-hb_session';
const DEFAULT_RESUMABLE_COOKIE = '__Host-hb_resume';
const DEFAULT_CSRF_COOKIE = '__Host-hb_csrf';
const TOKEN_BYTES = 32;

type RandomBytes = (size: number) => Uint8Array;

export interface AccessClock {
  now(): Date;
}

export interface SessionCookie {
  readonly name: string;
  readonly value: string;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: 'Lax' | 'Strict' | 'None';
  readonly path: '/';
  readonly maxAge: number;
  readonly expires: Date;
}

export interface CreateBrowserSessionInput {
  readonly sessionIdHash: Uint8Array;
  readonly accountOrGuestIdentity: string;
  readonly authorizationVersion: bigint;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface CreateMembershipSessionInput extends CreateBrowserSessionInput {
  readonly membershipId: MembershipId;
}

export interface RotateBrowserSessionInput {
  readonly sessionId: BrowserSessionId;
  readonly currentSessionIdHash: Uint8Array;
  readonly nextSessionIdHash: Uint8Array;
  readonly rotatedAt: Date;
}

/**
 * The persistence transaction boundary needed by the access service. Concrete
 * database repositories can implement these operations with row locks and a
 * transaction; the service never persists raw credentials.
 */
export interface AccessRepository {
  createBrowserSession(input: CreateBrowserSessionInput): Promise<BrowserSessionRecord>;
  createMembershipSession(
    input: CreateMembershipSessionInput,
    transaction?: SqlTransaction,
  ): Promise<BrowserSessionRecord>;
  findBrowserSessionByHash(sessionIdHash: Uint8Array): Promise<BrowserSessionRecord | null>;
  rotateBrowserSession(input: RotateBrowserSessionInput): Promise<BrowserSessionRecord>;
  revokeBrowserSession(sessionId: BrowserSessionId, revokedAt: Date): Promise<void>;
  revokeAllBrowserSessions(accountOrGuestIdentity: string, revokedAt: Date): Promise<void>;
  getAuthorizationVersion(
    accountOrGuestIdentity: string,
    transaction?: SqlTransaction,
  ): Promise<bigint>;
  findMembershipByCredentialHash(
    gameId: string,
    credentialHash: Uint8Array,
  ): Promise<MembershipRecord | null>;
  findMembershipByBrowserSessionId(
    sessionId: BrowserSessionId,
  ): Promise<MembershipRecord | null>;
}

export interface SessionServiceOptions {
  readonly secret: string | Uint8Array;
  readonly clock?: AccessClock;
  readonly sessionTtlMs?: number;
  readonly resumableCredentialTtlMs?: number;
  readonly sessionCookieName?: string;
  readonly resumableCookieName?: string;
  readonly csrfCookieName?: string;
  readonly randomBytes?: RandomBytes;
  readonly secureCookies?: boolean;
  readonly observability?: Observability;
}

export interface SessionAccessResult {
  readonly session: BrowserSessionDto;
  /** The raw value to set in the HttpOnly session cookie. */
  readonly sessionCredential: string;
  readonly sessionCookie: SessionCookie;
  /** The raw CSRF value may be returned to the browser as a header or non-HttpOnly cookie. */
  readonly csrfToken: string;
  readonly csrfCookie: SessionCookie;
}

export interface MembershipAccessResult extends SessionAccessResult {
  readonly membership: MembershipDto;
  /** The raw value to persist in the separate resumable-access cookie. */
  readonly resumableCredential: string;
  readonly resumableCookie: SessionCookie;
}

export interface AuthenticatedSession {
  readonly record: BrowserSessionRecord;
  readonly session: BrowserSessionDto;
}

interface CsrfPayload {
  readonly sessionHash: string;
  readonly expiresAt: number;
  readonly nonce: string;
}

const asCorrelationId = (): CorrelationId => randomUUID() as CorrelationId;
const asTimestamp = (value: Date): Timestamp => value.toISOString() as Timestamp;
const accessError = (
  code: DomainErrorCode,
  message: string,
  httpStatus: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503 = 401,
): HumanBingoError =>
  new HumanBingoError({
    code,
    message,
    correlationId: asCorrelationId(),
    retryable: false,
    httpStatus,
  });

const toBase64Url = (value: Uint8Array): string => Buffer.from(value).toString('base64url');
const fromBase64Url = (value: string): Uint8Array => Buffer.from(value, 'base64url');

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));

const validateSecret = (secret: string | Uint8Array): Uint8Array => {
  const value = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
  if (value.length < 32) {
    throw new Error('Session secret must contain at least 32 bytes');
  }
  return value;
};

const validateCredential = (credential: string, label: string): void => {
  if (credential.length < 32 || credential.length > 512 || !/^[A-Za-z0-9_-]+$/.test(credential)) {
    throw accessError(ErrorCode.Unauthorized, `Invalid ${label}`);
  }
};

const hashCredential = (secret: Uint8Array, credential: string): Uint8Array =>
  createHmac('sha256', secret).update(credential, 'utf8').digest();

const identityForMembership = (membership: MembershipRecord): string =>
  `membership:${membership.id}`;

const toSessionDto = (
  record: BrowserSessionRecord,
  membershipId?: MembershipId,
): BrowserSessionDto => {
  const authorizationVersion = Number(record.authorizationVersion);
  if (!Number.isSafeInteger(authorizationVersion)) {
    throw new Error('Session authorization version exceeds the safe wire range');
  }

  return {
    id: record.id,
    ...(membershipId === undefined ? {} : { membershipId }),
    expiresAt: asTimestamp(record.expiresAt),
    authorizationVersion,
  };
};

const toMembershipDto = (record: MembershipRecord): MembershipDto => ({
  id: record.id,
  gameId: record.gameId,
  participantId: record.participantId,
  createdAt: asTimestamp(record.createdAt),
  lastSeenAt: asTimestamp(record.lastSeenAt),
});

const serializeCookie = (cookie: SessionCookie): string => {
  const parts = [
    `${cookie.name}=${cookie.value}`,
    `Path=${cookie.path}`,
    `Max-Age=${cookie.maxAge}`,
    `Expires=${cookie.expires.toUTCString()}`,
    `SameSite=${cookie.sameSite}`,
  ];
  if (cookie.httpOnly) parts.push('HttpOnly');
  if (cookie.secure) parts.push('Secure');
  return parts.join('; ');
};

export const parseCookieHeader = (header: string | undefined, name: string): string | null => {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key === name) return part.slice(separator + 1).trim() || null;
  }
  return null;
};

export class SessionService {
  readonly #repository: AccessRepository;
  readonly #secret: Uint8Array;
  readonly #clock: AccessClock;
  readonly #sessionTtlMs: number;
  readonly #resumableCredentialTtlMs: number;
  readonly #sessionCookieName: string;
  readonly #resumableCookieName: string;
  readonly #csrfCookieName: string;
  readonly #randomBytes: RandomBytes;
  readonly #secureCookies: boolean;
  readonly #observability: Observability | undefined;

  public constructor(repository: AccessRepository, options: SessionServiceOptions) {
    this.#repository = repository;
    this.#secret = validateSecret(options.secret);
    this.#clock = options.clock ?? { now: () => new Date() };
    this.#sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    if (!Number.isInteger(this.#sessionTtlMs) || this.#sessionTtlMs <= 0) {
      throw new Error('Session TTL must be a positive integer');
    }
    this.#resumableCredentialTtlMs = options.resumableCredentialTtlMs ?? 1000 * 60 * 60 * 24 * 365;
    if (!Number.isInteger(this.#resumableCredentialTtlMs) || this.#resumableCredentialTtlMs <= 0) {
      throw new Error('Resumable credential TTL must be a positive integer');
    }
    this.#sessionCookieName = options.sessionCookieName ?? DEFAULT_SESSION_COOKIE;
    this.#resumableCookieName = options.resumableCookieName ?? DEFAULT_RESUMABLE_COOKIE;
    this.#csrfCookieName = options.csrfCookieName ?? DEFAULT_CSRF_COOKIE;
    this.#randomBytes = options.randomBytes ?? ((size) => randomBytes(size));
    this.#secureCookies = options.secureCookies ?? true;
    this.#observability = options.observability;
  }

  public async createHostSession(accountOrGuestIdentity: string): Promise<SessionAccessResult> {
    const identity = this.#requireIdentity(accountOrGuestIdentity);
    const now = this.#clock.now();
    const sessionCredential = this.#newCredential();
    const record = await this.#createSession(identity, now, undefined, sessionCredential);
    return this.#buildAccessResult(record, sessionCredential);
  }

  public createResumableCredential(): { readonly credential: string; readonly hash: Uint8Array } {
    const credential = this.#newCredential();
    return { credential, hash: hashCredential(this.#secret, credential) };
  }

  /** Create a browser session bound to an already-created membership. */
  public async createMembershipSession(
    membership: MembershipRecord,
    resumableCredential: string,
  ): Promise<MembershipAccessResult> {
    this.#validateAccessCredential(
      resumableCredential,
      'resumable credential',
      'membership',
      membership.gameId,
    );
    const membershipHash = hashCredential(this.#secret, resumableCredential);
    const storedMembership = await this.#repository.findMembershipByCredentialHash(
      membership.gameId,
      membershipHash,
    );
    if (storedMembership === null || storedMembership.id !== membership.id) {
      throw this.#authorizationError(
        ErrorCode.Unauthorized,
        'Membership access is invalid',
        'membership',
        membership.gameId,
      );
    }
    // Use the repository's canonical membership record after credential
    // verification. The object supplied by a caller is not an authorization
    // source and must not be able to change the game or participant binding.
    return this.#openMembershipSession(storedMembership, resumableCredential);
  }

  /**
   * Bind a browser session to a membership record without re-reading the
   * membership row. This is the trusted variant for in-transaction producers
   * such as MembershipService, which have already verified the membership
   * through their own repository and whose staged row is not yet visible to
   * other connections. Callers that possess only a raw credential must use
   * {@link createMembershipSession} or {@link resumeMembership} instead.
   */
  public async bindMembershipSession(
    membership: MembershipRecord,
    resumableCredential: string,
    transaction?: SqlTransaction,
  ): Promise<MembershipAccessResult> {
    this.#validateAccessCredential(
      resumableCredential,
      'resumable credential',
      'membership',
      membership.gameId,
    );
    return this.#openMembershipSession(membership, resumableCredential, transaction);
  }

  async #openMembershipSession(
    membership: MembershipRecord,
    resumableCredential: string,
    transaction?: SqlTransaction,
  ): Promise<MembershipAccessResult> {
    const now = this.#clock.now();
    const identity = identityForMembership(membership);
    const sessionCredential = this.#newCredential();
    const sessionHash = hashCredential(this.#secret, sessionCredential);
    const authorizationVersion = await this.#repository.getAuthorizationVersion(
      identity,
      transaction,
    );
    const record = await this.#repository.createMembershipSession(
      {
        membershipId: membership.id,
        sessionIdHash: sessionHash,
        accountOrGuestIdentity: identity,
        authorizationVersion,
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.#sessionTtlMs),
      },
      transaction,
    );
    return this.#buildMembershipAccessResult(
      record,
      sessionCredential,
      resumableCredential,
      membership,
    );
  }

  /** Resume a membership and rotate to a fresh browser session credential. */
  public async resumeMembership(
    gameId: string,
    resumableCredential: string,
  ): Promise<MembershipAccessResult> {
    this.#validateAccessCredential(
      resumableCredential,
      'resumable credential',
      'membership',
      gameId,
    );
    const credentialHash = hashCredential(this.#secret, resumableCredential);
    const membership = await this.#repository.findMembershipByCredentialHash(
      gameId,
      credentialHash,
    );
    if (membership === null) {
      throw this.#authorizationError(
        ErrorCode.Unauthorized,
        'Membership access is invalid',
        'membership',
        gameId,
      );
    }
    return this.createMembershipSession(membership, resumableCredential);
  }

  public async authenticateSession(sessionCredential: string): Promise<AuthenticatedSession> {
    this.#validateAccessCredential(sessionCredential, 'session credential', 'session');
    const now = this.#clock.now();
    const hash = hashCredential(this.#secret, sessionCredential);
    const record = await this.#repository.findBrowserSessionByHash(hash);
    if (
      record === null ||
      record.revokedAt !== null ||
      record.expiresAt.getTime() <= now.getTime()
    ) {
      throw this.#authorizationError(
        ErrorCode.Unauthorized,
        'Session is invalid or expired',
        'session',
      );
    }

    const currentVersion = await this.#repository.getAuthorizationVersion(
      record.accountOrGuestIdentity,
    );
    if (currentVersion !== record.authorizationVersion) {
      throw this.#authorizationError(
        ErrorCode.Unauthorized,
        'Session authorization has changed',
        'session',
      );
    }
    return { record, session: toSessionDto(record) };
  }

  public async rotateSession(sessionCredential: string): Promise<SessionAccessResult> {
    const authenticated = await this.authenticateSession(sessionCredential);
    const nextCredential = this.#newCredential();
    const nextHash = hashCredential(this.#secret, nextCredential);
    const record = await this.#repository.rotateBrowserSession({
      sessionId: authenticated.record.id,
      currentSessionIdHash: hashCredential(this.#secret, sessionCredential),
      nextSessionIdHash: nextHash,
      rotatedAt: this.#clock.now(),
    });
    return this.#buildAccessResult(record, nextCredential);
  }

  public async issueCsrfToken(sessionCredential: string): Promise<string> {
    const authenticated = await this.authenticateSession(sessionCredential);
    const payload: CsrfPayload = {
      sessionHash: toBase64Url(authenticated.record.sessionIdHash),
      expiresAt: authenticated.record.expiresAt.getTime(),
      nonce: toBase64Url(this.#randomBytes(16)),
    };
    const encodedPayload = toBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
    const mac = toBase64Url(createHmac('sha256', this.#secret).update(encodedPayload).digest());
    return `${encodedPayload}.${mac}`;
  }

  public async validateCsrfToken(sessionCredential: string, csrfToken: string): Promise<void> {
    const authenticated = await this.authenticateSession(sessionCredential);
    const tokenParts = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(csrfToken);
    if (tokenParts === null) {
      throw this.#authorizationError(
        ErrorCode.Forbidden,
        'CSRF validation failed',
        'csrf',
        undefined,
        403,
      );
    }
    const encodedPayload = tokenParts[1]!;
    const encodedMac = tokenParts[2]!;

    const expectedMac = createHmac('sha256', this.#secret).update(encodedPayload).digest();
    const receivedMac = fromBase64Url(encodedMac);
    if (!equalBytes(expectedMac, receivedMac)) {
      throw this.#authorizationError(
        ErrorCode.Forbidden,
        'CSRF validation failed',
        'csrf',
        undefined,
        403,
      );
    }

    let payload: CsrfPayload;
    try {
      payload = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      ) as CsrfPayload;
    } catch {
      throw this.#authorizationError(
        ErrorCode.Forbidden,
        'CSRF validation failed',
        'csrf',
        undefined,
        403,
      );
    }

    const now = this.#clock.now().getTime();
    const sessionHashMatches =
      typeof payload.sessionHash === 'string' &&
      payload.sessionHash === toBase64Url(authenticated.record.sessionIdHash);
    if (
      !sessionHashMatches ||
      !Number.isSafeInteger(payload.expiresAt) ||
      payload.expiresAt <= now ||
      payload.expiresAt !== authenticated.record.expiresAt.getTime()
    ) {
      throw this.#authorizationError(
        ErrorCode.Forbidden,
        'CSRF validation failed',
        'csrf',
        undefined,
        403,
      );
    }
  }

  public async logout(
    sessionCredential: string,
  ): Promise<{ readonly sessionCookie: SessionCookie; readonly csrfCookie: SessionCookie }> {
    const now = this.#clock.now();
    try {
      const authenticated = await this.authenticateSession(sessionCredential);
      await this.#repository.revokeBrowserSession(authenticated.record.id, now);
    } catch (error: unknown) {
      if (!(error instanceof HumanBingoError) || error.code !== ErrorCode.Unauthorized) throw error;
    }
    return {
      sessionCookie: this.#expiredCookie(this.#sessionCookieName, true, now),
      csrfCookie: this.#expiredCookie(this.#csrfCookieName, false, now),
    };
  }

  public async revokeAllSessions(accountOrGuestIdentity: string): Promise<void> {
    await this.#repository.revokeAllBrowserSessions(
      this.#requireIdentity(accountOrGuestIdentity),
      this.#clock.now(),
    );
  }

  public sessionCookieHeader(cookie: SessionCookie): string {
    return serializeCookie(cookie);
  }

  #validateAccessCredential(
    credential: string,
    label: string,
    resource: string,
    gameId?: string,
  ): void {
    try {
      validateCredential(credential, label);
    } catch (error: unknown) {
      if (error instanceof HumanBingoError && error.code === ErrorCode.Unauthorized) {
        recordAuthorizationDenial(this.#observability, {
          correlationId: String(error.correlationId),
          ...(gameId === undefined ? {} : { gameId }),
          resource,
          reason: error.code,
        });
      }
      throw error;
    }
  }

  #authorizationError(
    code: DomainErrorCode,
    message: string,
    resource: string,
    gameId?: string,
    httpStatus: 401 | 403 = 401,
  ): HumanBingoError {
    const error = accessError(code, message, httpStatus);
    recordAuthorizationDenial(this.#observability, {
      correlationId: String(error.correlationId),
      ...(gameId === undefined ? {} : { gameId }),
      resource,
      reason: code,
    });
    return error;
  }

  #requireIdentity(identity: string): string {
    const normalized = identity.trim();
    if (normalized.length === 0 || normalized.length > 256) {
      throw accessError(ErrorCode.ValidationError, 'Session identity is required', 422);
    }
    return normalized;
  }

  #newCredential(): string {
    return toBase64Url(this.#randomBytes(TOKEN_BYTES));
  }

  async #createSession(
    identity: string,
    now: Date,
    membershipId: MembershipId | undefined,
    sessionCredential: string,
  ): Promise<BrowserSessionRecord> {
    const sessionHash = hashCredential(this.#secret, sessionCredential);
    const authorizationVersion = await this.#repository.getAuthorizationVersion(identity);
    const input: CreateBrowserSessionInput = {
      sessionIdHash: sessionHash,
      accountOrGuestIdentity: identity,
      authorizationVersion,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.#sessionTtlMs),
    };
    if (membershipId !== undefined) {
      return this.#repository.createMembershipSession({ ...input, membershipId });
    }
    return this.#repository.createBrowserSession(input);
  }

  #buildAccessResult(record: BrowserSessionRecord, sessionCredential: string): SessionAccessResult {
    const csrfToken = this.#issueCsrfTokenForRecord(record);
    const expiresAt = record.expiresAt;
    return {
      session: toSessionDto(record),
      sessionCredential,
      sessionCookie: this.#cookie(this.#sessionCookieName, sessionCredential, true, expiresAt),
      csrfToken,
      csrfCookie: this.#cookie(this.#csrfCookieName, csrfToken, false, expiresAt),
    };
  }

  #buildMembershipAccessResult(
    record: BrowserSessionRecord,
    sessionCredential: string,
    resumableCredential: string,
    membership: MembershipRecord,
  ): MembershipAccessResult {
    const base = this.#buildAccessResult(record, sessionCredential);
    return {
      ...base,
      membership: toMembershipDto(membership),
      resumableCredential,
      resumableCookie: this.#cookie(
        this.#resumableCookieName,
        resumableCredential,
        true,
        new Date(this.#clock.now().getTime() + this.#resumableCredentialTtlMs),
      ),
    };
  }

  #issueCsrfTokenForRecord(record: BrowserSessionRecord): string {
    const payload: CsrfPayload = {
      sessionHash: toBase64Url(record.sessionIdHash),
      expiresAt: record.expiresAt.getTime(),
      nonce: toBase64Url(this.#randomBytes(16)),
    };
    const encodedPayload = toBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
    const mac = toBase64Url(createHmac('sha256', this.#secret).update(encodedPayload).digest());
    return `${encodedPayload}.${mac}`;
  }

  #cookie(name: string, value: string, httpOnly: boolean, expires: Date): SessionCookie {
    const maxAge = Math.max(
      0,
      Math.floor((expires.getTime() - this.#clock.now().getTime()) / 1000),
    );
    return {
      name,
      value,
      httpOnly,
      secure: this.#secureCookies,
      sameSite: 'Lax',
      path: '/',
      maxAge,
      expires: new Date(expires.getTime()),
    };
  }

  #expiredCookie(name: string, httpOnly: boolean, now: Date): SessionCookie {
    return {
      name,
      value: '',
      httpOnly,
      secure: this.#secureCookies,
      sameSite: 'Lax',
      path: '/',
      maxAge: 0,
      expires: new Date(now.getTime() - 1000),
    };
  }
}

export const credentialHash = (secret: string | Uint8Array, credential: string): Uint8Array => {
  return createHmac('sha256', validateSecret(secret)).update(credential, 'utf8').digest();
};

export const serializeSessionCookie = serializeCookie;
export const sessionCookieNames = {
  session: DEFAULT_SESSION_COOKIE,
  resumable: DEFAULT_RESUMABLE_COOKIE,
  csrf: DEFAULT_CSRF_COOKIE,
} as const;
