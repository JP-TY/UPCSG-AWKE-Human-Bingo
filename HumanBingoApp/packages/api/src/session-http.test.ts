/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest';
import type { BrowserSessionRecord, MembershipRecord } from '@human-bingo/persistence';
import {
  SessionService,
  type AccessRepository,
  type CreateBrowserSessionInput,
  type CreateMembershipSessionInput,
  type RotateBrowserSessionInput,
} from './access/session-service.js';
import { HttpApi } from './http.js';

const SECRET = '01234567890123456789012345678901';

const asBytes = (value: Uint8Array): Uint8Array => new Uint8Array(value);

class FakeAccessRepository implements AccessRepository {
  readonly sessions = new Map<string, BrowserSessionRecord>();
  readonly memberships = new Map<string, MembershipRecord>();
  #nextSessionId = 100;

  private static key(hash: Uint8Array): string {
    return Buffer.from(hash).toString('base64');
  }

  private static makeSession(input: CreateBrowserSessionInput, id: string): BrowserSessionRecord {
    return {
      id: id as BrowserSessionRecord['id'],
      sessionIdHash: asBytes(input.sessionIdHash),
      accountOrGuestIdentity: input.accountOrGuestIdentity,
      authorizationVersion: input.authorizationVersion,
      createdAt: new Date(input.createdAt),
      rotatedAt: null,
      expiresAt: new Date(input.expiresAt),
      revokedAt: null,
    };
  }

  public createBrowserSession(input: CreateBrowserSessionInput): Promise<BrowserSessionRecord> {
    const record = FakeAccessRepository.makeSession(
      input,
      `00000000-0000-0000-0000-0000000000${this.#nextSessionId++}`,
    );
    this.sessions.set(FakeAccessRepository.key(input.sessionIdHash), record);
    return Promise.resolve(record);
  }

  public createMembershipSession(
    input: CreateMembershipSessionInput,
  ): Promise<BrowserSessionRecord> {
    return this.createBrowserSession(input);
  }

  public findBrowserSessionByHash(sessionIdHash: Uint8Array): Promise<BrowserSessionRecord | null> {
    return Promise.resolve(this.sessions.get(FakeAccessRepository.key(sessionIdHash)) ?? null);
  }

  public rotateBrowserSession(input: RotateBrowserSessionInput): Promise<BrowserSessionRecord> {
    const current = this.sessions.get(FakeAccessRepository.key(input.currentSessionIdHash));
    if (current === undefined || current.id !== input.sessionId)
      return Promise.reject(new Error('session rotation conflict'));
    const next: BrowserSessionRecord = {
      ...current,
      sessionIdHash: asBytes(input.nextSessionIdHash),
      rotatedAt: new Date(input.rotatedAt),
    };
    this.sessions.delete(FakeAccessRepository.key(input.currentSessionIdHash));
    this.sessions.set(FakeAccessRepository.key(input.nextSessionIdHash), next);
    return Promise.resolve(next);
  }

  public revokeBrowserSession(_sessionId: string, _revokedAt: Date): Promise<void> {
    return Promise.resolve();
  }

  public revokeAllBrowserSessions(
    _accountOrGuestIdentity: string,
    _revokedAt: Date,
  ): Promise<void> {
    return Promise.resolve();
  }

  public getAuthorizationVersion(_accountOrGuestIdentity: string): Promise<bigint> {
    return Promise.resolve(0n);
  }

  public findMembershipByCredentialHash(
    _gameId: string,
    _credentialHash: Uint8Array,
  ): Promise<MembershipRecord | null> {
    return Promise.resolve(null);
  }

  public findMembershipByBrowserSessionId(_sessionId: string): Promise<MembershipRecord | null> {
    return Promise.resolve(null);
  }
}

const request = (
  method: string,
  path: string,
  cookie?: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request =>
  new Request(`https://app.example${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie === undefined ? {} : { cookie }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const json = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

const makeApi = (): HttpApi => {
  const sessions = new SessionService(new FakeAccessRepository(), { secret: SECRET });
  return new HttpApi({
    sessions,
    authorization: {} as never,
    gameConfiguration: {
      createGame: async (command: { readonly name: string }) => ({
        game: { id: 'game-1', name: command.name, status: 'draft' },
        version: 1,
      }),
    } as never,
    invitations: {} as never,
    onboarding: {} as never,
    snapshots: {} as never,
    hostOverview: {} as never,
    verification: {} as never,
    push: {} as never,
    principalForSession: async (authenticated) => ({
      accountOrGuestIdentity: authenticated.record.accountOrGuestIdentity,
      authorizationVersion: authenticated.record.authorizationVersion,
    }),
  });
};

const cookieValue = (response: Response, name: string): string | undefined =>
  response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.split(';', 1)[0];

describe('browser session creation flow', () => {
  it('creates a guest session with cookies and a CSRF token', async () => {
    const api = makeApi();
    const created = await api.handle(request('POST', '/api/session'));

    expect(created.status).toBe(201);
    const payload = await json(created);
    expect(payload.session).toBeDefined();
    expect(typeof payload.csrfToken).toBe('string');
    expect(cookieValue(created, '__Host-hb_session')).toBeDefined();
    expect(cookieValue(created, '__Host-hb_csrf')).toBe(
      `__Host-hb_csrf=${payload.csrfToken as string}`,
    );
    expect(created.headers.getSetCookie()[0]).toContain('HttpOnly');
    expect(created.headers.getSetCookie()[1]).not.toContain('HttpOnly');
  });

  it('requires the CSRF token to create a draft game', async () => {
    const api = makeApi();
    const created = await api.handle(request('POST', '/api/session'));
    const payload = await json(created);
    const sessionCookie = cookieValue(created, '__Host-hb_session');
    expect(sessionCookie).toBeDefined();

    const rejected = await api.handle(
      request(
        'POST',
        '/api/games',
        sessionCookie,
        { name: 'Friday team bingo' },
        { 'idempotency-key': 'draft-1' },
      ),
    );
    expect(rejected.status).toBe(403);

    const accepted = await api.handle(
      request(
        'POST',
        '/api/games',
        sessionCookie,
        { name: 'Friday team bingo' },
        { 'x-csrf-token': String(payload.csrfToken), 'idempotency-key': 'draft-1' },
      ),
    );
    expect(accepted.status).toBe(201);
    expect(await json(accepted)).toMatchObject({
      game: { name: 'Friday team bingo', status: 'draft' },
    });
  });

  it('restores an existing session with a fresh CSRF token', async () => {
    const api = makeApi();
    const created = await api.handle(request('POST', '/api/session'));
    const sessionCookie = cookieValue(created, '__Host-hb_session');
    expect(sessionCookie).toBeDefined();

    const restored = await api.handle(request('GET', '/api/session', sessionCookie));
    expect(restored.status).toBe(200);
    const payload = await json(restored);
    expect(payload.session).toBeDefined();
    expect(typeof payload.csrfToken).toBe('string');

    const draft = await api.handle(
      request(
        'POST',
        '/api/games',
        sessionCookie,
        { name: 'Restored session draft' },
        { 'x-csrf-token': String(payload.csrfToken), 'idempotency-key': 'draft-2' },
      ),
    );
    expect(draft.status).toBe(201);
  });

  it('rejects session creation with a body over the request size limit', async () => {
    const api = makeApi();
    const oversized = request('POST', '/api/session', undefined, {
      padding: 'x'.repeat(100 * 1024),
    });
    const response = await api.handle(oversized);
    expect(response.status).toBe(422);
  });
});
