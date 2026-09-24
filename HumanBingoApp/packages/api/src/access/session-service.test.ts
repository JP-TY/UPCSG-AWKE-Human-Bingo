import { describe, expect, it } from 'vitest';
import type { BrowserSessionId, BrowserSessionRecord, MembershipRecord } from '@human-bingo/persistence';
import { createObservability, InMemoryAuditSink } from '../observability.js';
import type { Observability } from '../observability.js';
import {
  credentialHash,
  parseCookieHeader,
  serializeSessionCookie,
  SessionService,
  type AccessRepository,
  type CreateBrowserSessionInput,
  type CreateMembershipSessionInput,
  type RotateBrowserSessionInput,
} from './session-service.js';

const SECRET = '01234567890123456789012345678901';
const MEMBERSHIP_ID = '00000000-0000-0000-0000-000000000002';
const PARTICIPANT_ID = '00000000-0000-0000-0000-000000000003';
const GAME_ID = '00000000-0000-0000-0000-000000000004';

const asBytes = (value: Uint8Array): Uint8Array => new Uint8Array(value);
const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

class FakeClock {
  #current: Date;

  public constructor(value = '2025-01-01T00:00:00.000Z') {
    this.#current = new Date(value);
  }

  public now(): Date {
    return new Date(this.#current.getTime());
  }

  public advance(milliseconds: number): void {
    this.#current = new Date(this.#current.getTime() + milliseconds);
  }
}

class FakeAccessRepository implements AccessRepository {
  readonly sessions = new Map<string, BrowserSessionRecord>();
  readonly memberships = new Map<string, MembershipRecord>();
  readonly authorizationVersions = new Map<string, bigint>();
  readonly revokedSessionIds: string[] = [];
  readonly rotated: RotateBrowserSessionInput[] = [];
  #nextSessionId = 10;

  public createBrowserSession(input: CreateBrowserSessionInput): Promise<BrowserSessionRecord> {
    const record = this.#makeSession(
      input,
      `00000000-0000-0000-0000-0000000000${this.#nextSessionId++}`,
    );
    this.sessions.set(this.#key(input.sessionIdHash), record);
    return Promise.resolve(record);
  }

  public async createMembershipSession(
    input: CreateMembershipSessionInput,
  ): Promise<BrowserSessionRecord> {
    const record = await this.createBrowserSession(input);
    const membership = [...this.memberships.values()].find(
      (candidate) => candidate.id === input.membershipId,
    );
    if (membership !== undefined) {
      this.memberships.set(membership.id, { ...membership, browserSessionId: record.id });
    }
    return record;
  }

  public findBrowserSessionByHash(sessionIdHash: Uint8Array): Promise<BrowserSessionRecord | null> {
    return Promise.resolve(this.sessions.get(this.#key(sessionIdHash)) ?? null);
  }

  public rotateBrowserSession(input: RotateBrowserSessionInput): Promise<BrowserSessionRecord> {
    const old = this.sessions.get(this.#key(input.currentSessionIdHash));
    if (old === undefined || old.id !== input.sessionId)
      throw new Error('session rotation conflict');
    const next = {
      ...old,
      sessionIdHash: asBytes(input.nextSessionIdHash),
      rotatedAt: new Date(input.rotatedAt),
    };
    this.sessions.delete(this.#key(input.currentSessionIdHash));
    this.sessions.set(this.#key(input.nextSessionIdHash), next);
    this.rotated.push(input);
    return Promise.resolve(next);
  }

  public revokeBrowserSession(sessionId: string, revokedAt: Date): Promise<void> {
    const record = [...this.sessions.values()].find((candidate) => candidate.id === sessionId);
    if (record === undefined) throw new Error('session not found');
    const revoked = { ...record, revokedAt: new Date(revokedAt) };
    this.sessions.set(this.#key(record.sessionIdHash), revoked);
    this.revokedSessionIds.push(sessionId);
    return Promise.resolve();
  }

  public revokeAllBrowserSessions(identity: string, revokedAt: Date): Promise<void> {
    for (const [hash, record] of this.sessions) {
      if (record.accountOrGuestIdentity === identity && record.revokedAt === null) {
        this.sessions.set(hash, { ...record, revokedAt: new Date(revokedAt) });
        this.revokedSessionIds.push(record.id);
      }
    }
    return Promise.resolve();
  }

  public getAuthorizationVersion(
    identity: string,
    _transaction?: never,
  ): Promise<bigint> {
    void _transaction;
    return Promise.resolve(this.authorizationVersions.get(identity) ?? 0n);
  }

  public findMembershipByCredentialHash(
    gameId: string,
    resumableCredentialHash: Uint8Array,
  ): Promise<MembershipRecord | null> {
    return Promise.resolve(
      [...this.memberships.values()].find(
        (membership) =>
          membership.gameId === gameId &&
          equalBytes(membership.resumableCredentialHash, resumableCredentialHash),
      ) ?? null,
    );
  }

  public findMembershipByBrowserSessionId(
    sessionId: BrowserSessionId,
  ): Promise<MembershipRecord | null> {
    return Promise.resolve(
      [...this.memberships.values()].find(
        (membership) => membership.browserSessionId === sessionId,
      ) ?? null,
    );
  }

  public addMembership(credential: string): MembershipRecord {
    const membership: MembershipRecord = {
      id: MEMBERSHIP_ID as MembershipRecord['id'],
      gameId: GAME_ID as MembershipRecord['gameId'],
      participantId: PARTICIPANT_ID as MembershipRecord['participantId'],
      browserSessionId: null,
      resumableCredentialHash: credentialHash(SECRET, credential),
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      lastSeenAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    this.memberships.set(membership.id, membership);
    return membership;
  }

  #key(value: Uint8Array): string {
    return Buffer.from(value).toString('hex');
  }

  #makeId(value: string): BrowserSessionRecord['id'] {
    return value as BrowserSessionRecord['id'];
  }

  #makeSession(input: CreateBrowserSessionInput, id: string): BrowserSessionRecord {
    return {
      id: this.#makeId(id),
      sessionIdHash: asBytes(input.sessionIdHash),
      accountOrGuestIdentity: input.accountOrGuestIdentity,
      authorizationVersion: input.authorizationVersion,
      createdAt: new Date(input.createdAt),
      rotatedAt: null,
      expiresAt: new Date(input.expiresAt),
      revokedAt: null,
    };
  }
}

const createRandomBytes = (): ((size: number) => Uint8Array) => {
  let counter = 1;
  return (size) => {
    const value = Uint8Array.from({ length: size }, () => counter % 256);
    counter += 1;
    return value;
  };
};

const makeService = (
  repository: FakeAccessRepository,
  clock: FakeClock,
  observability?: Observability,
): SessionService =>
  new SessionService(repository, {
    secret: SECRET,
    clock,
    sessionTtlMs: 60_000,
    resumableCredentialTtlMs: 31_536_000_000,
    randomBytes: createRandomBytes(),
    ...(observability === undefined ? {} : { observability }),
  });

describe('SessionService', () => {
  it('creates a secure host session and exposes only safe session metadata', async () => {
    const repository = new FakeAccessRepository();
    const clock = new FakeClock();
    const service = makeService(repository, clock);

    const result = await service.createHostSession(' host-account ');
    const serialized = serializeSessionCookie(result.sessionCookie);

    expect(result.sessionCredential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const generatedResumable = service.createResumableCredential();
    expect(generatedResumable.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      equalBytes(generatedResumable.hash, credentialHash(SECRET, generatedResumable.credential)),
    ).toBe(true);
    expect(result.session.authorizationVersion).toBe(0);
    expect(result.session).not.toHaveProperty('sessionCredential');
    expect(result.sessionCookie.httpOnly).toBe(true);
    expect(result.sessionCookie.secure).toBe(true);
    expect(serialized).toContain('HttpOnly');
    expect(serialized).toContain('Secure');
    expect(parseCookieHeader(serialized, result.sessionCookie.name)).toBe(result.sessionCredential);
    await expect(service.authenticateSession(result.sessionCredential)).resolves.toMatchObject({
      session: { id: result.session.id },
    });
  });

  it('rotates the session credential and invalidates the previous credential and CSRF token', async () => {
    const repository = new FakeAccessRepository();
    const clock = new FakeClock();
    const service = makeService(repository, clock);
    const first = await service.createHostSession('host-account');

    await expect(
      service.validateCsrfToken(first.sessionCredential, first.csrfToken),
    ).resolves.toBeUndefined();
    const rotated = await service.rotateSession(first.sessionCredential);

    expect(rotated.session.id).toBe(first.session.id);
    expect(rotated.sessionCredential).not.toBe(first.sessionCredential);
    expect(repository.rotated).toHaveLength(1);
    await expect(service.authenticateSession(first.sessionCredential)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(
      service.validateCsrfToken(rotated.sessionCredential, first.csrfToken),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      service.validateCsrfToken(rotated.sessionCredential, rotated.csrfToken),
    ).resolves.toBeUndefined();
  });

  it('resumes only the requested game membership and binds a fresh session', async () => {
    const repository = new FakeAccessRepository();
    const clock = new FakeClock();
    const resumableCredential = 'resume-credential-012345678901234567890123';
    const membership = repository.addMembership(resumableCredential);
    const service = makeService(repository, clock);

    const result = await service.resumeMembership(GAME_ID, resumableCredential);

    expect(result.membership.id).toBe(membership.id);
    expect(result.membership).not.toHaveProperty('resumableCredentialHash');
    expect(result.resumableCookie.httpOnly).toBe(true);
    expect(result.resumableCookie.expires.getTime()).toBeGreaterThan(
      result.sessionCookie.expires.getTime(),
    );
    expect(repository.memberships.get(membership.id)?.browserSessionId).toBe(result.session.id);
    await expect(
      service.resumeMembership('00000000-0000-0000-0000-000000000099', resumableCredential),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('rejects expired, revoked, and authorization-version-stale sessions', async () => {
    const repository = new FakeAccessRepository();
    const clock = new FakeClock();
    const service = makeService(repository, clock);
    const result = await service.createHostSession('host-account');

    clock.advance(60_000);
    await expect(service.authenticateSession(result.sessionCredential)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });

    const second = await service.createHostSession('host-account');
    repository.authorizationVersions.set('host-account', 1n);
    await expect(service.authenticateSession(second.sessionCredential)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });

    repository.authorizationVersions.set('host-account', 0n);
    const third = await service.createHostSession('host-account');
    await service.logout(third.sessionCredential);
    await expect(service.authenticateSession(third.sessionCredential)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(repository.revokedSessionIds).toContain(third.session.id);
  });

  it('uses the canonical membership binding after resumable credential verification', async () => {
    const repository = new FakeAccessRepository();
    const clock = new FakeClock();
    const resumableCredential = 'resume-credential-012345678901234567890123';
    const membership = repository.addMembership(resumableCredential);
    const service = makeService(repository, clock);
    const suppliedMembership: MembershipRecord = {
      ...membership,
      participantId: '00000000-0000-0000-0000-000000000099' as MembershipRecord['participantId'],
      lastSeenAt: new Date('2030-01-01T00:00:00.000Z'),
    };

    const result = await service.createMembershipSession(suppliedMembership, resumableCredential);

    expect(result.membership.participantId).toBe(membership.participantId);
    expect(result.membership.lastSeenAt).toBe(membership.lastSeenAt.toISOString());
    expect(repository.memberships.get(membership.id)?.browserSessionId).toBe(result.session.id);
  });

  it('binds a session to a supplied staged membership record without re-reading the row', async () => {
    const repository = new FakeAccessRepository();
    const clock = new FakeClock();
    const service = makeService(repository, clock);
    const resumableCredential = 'resume-credential-012345678901234567890123';
    const stagedMembership: MembershipRecord = {
      id: MEMBERSHIP_ID as MembershipRecord['id'],
      gameId: GAME_ID as MembershipRecord['gameId'],
      participantId: PARTICIPANT_ID as MembershipRecord['participantId'],
      browserSessionId: null,
      resumableCredentialHash: credentialHash(SECRET, resumableCredential),
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      lastSeenAt: new Date('2025-01-01T00:00:00.000Z'),
    };

    const result = await service.bindMembershipSession(stagedMembership, resumableCredential);

    expect(result.membership.id).toBe(stagedMembership.id);
    expect(result.session.id).toBeDefined();
    await expect(
      service.authenticateSession(result.sessionCredential),
    ).resolves.toMatchObject({ session: { id: result.session.id } });
    await expect(
      service.bindMembershipSession(stagedMembership, 'not-a-valid-credential'),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('binds a session to a committed membership and records the browser session id', async () => {
    const repository = new FakeAccessRepository();
    const clock = new FakeClock();
    const service = makeService(repository, clock);
    const resumableCredential = 'resume-credential-012345678901234567890123';
    const membership = repository.addMembership(resumableCredential);

    const result = await service.bindMembershipSession(membership, resumableCredential);

    expect(repository.memberships.get(membership.id)?.browserSessionId).toBe(result.session.id);
    expect((await repository.findMembershipByBrowserSessionId(result.session.id))?.id).toBe(
      membership.id,
    );
  });

  it('rejects a CSRF token exactly at the session expiry boundary', async () => {
    const repository = new FakeAccessRepository();
    const clock = new FakeClock();
    const service = makeService(repository, clock);
    const result = await service.createHostSession('host-account');

    clock.advance(60_000);
    await expect(
      service.validateCsrfToken(result.sessionCredential, result.csrfToken),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects non-token CSRF input with a typed forbidden error', async () => {
    const repository = new FakeAccessRepository();
    const service = makeService(repository, new FakeClock());
    const result = await service.createHostSession('host-account');

    await expect(
      service.validateCsrfToken(result.sessionCredential, 'not a token'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('audits rejected session authorization without recording the credential', async () => {
    const repository = new FakeAccessRepository();
    const audit = new InMemoryAuditSink();
    const observability = createObservability({
      audit,
      now: () => new Date('2025-01-01T00:00:00.000Z'),
    });
    const service = makeService(repository, new FakeClock(), observability);

    await expect(service.authenticateSession('malformed')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });

    expect(audit.events()).toHaveLength(1);
    expect(audit.events()[0]).toMatchObject({
      event: 'authorization.denied',
      resource: 'session',
      reason: 'UNAUTHORIZED',
    });
    expect(JSON.stringify(audit.events())).not.toContain('malformed');
  });
});
