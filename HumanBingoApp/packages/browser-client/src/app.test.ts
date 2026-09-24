import { describe, expect, it } from 'vitest';
import { bootstrapSession, matchRoute } from './app.js';
import type { SessionFetcher } from './app.js';

const session = {
  id: 'session-1',
  expiresAt: '2025-01-01T00:00:00.000Z',
  authorizationVersion: 3,
};

function responseFetcher(response: Response): SessionFetcher {
  return () => Promise.resolve(response);
}

describe('browser app routing', () => {
  it('matches the supported application routes', () => {
    expect(matchRoute('/')).toEqual({ name: 'home' });
    expect(matchRoute('/join')).toEqual({ name: 'join' });
    expect(matchRoute('/invite/opaque-token')).toEqual({ name: 'invite', token: 'opaque-token' });
    expect(matchRoute('/game/game-1')).toEqual({ name: 'game', gameId: 'game-1' });
    expect(matchRoute('/game/game-1/host')).toEqual({ name: 'host', gameId: 'game-1' });
    expect(matchRoute('/game/game-1/notifications')).toEqual({
      name: 'notifications',
      gameId: 'game-1',
    });
    expect(matchRoute('/not-a-route')).toEqual({ name: 'not-found' });
    expect(matchRoute('/invite/%E0%A4%A')).toEqual({ name: 'not-found' });
  });

  it('removes query and hash fragments while matching a route', () => {
    expect(matchRoute('/join?from=qr#start')).toEqual({ name: 'join' });
  });
});

describe('session bootstrap', () => {
  it('restores an authenticated session from the response', async () => {
    const result = await bootstrapSession(responseFetcher(Response.json({ session })));
    expect(result).toEqual({ status: 'authenticated', session });
  });

  it('restores an authenticated session with its CSRF token', async () => {
    const result = await bootstrapSession(
      responseFetcher(Response.json({ session, csrfToken: 'csrf-1' })),
    );
    expect(result).toEqual({ status: 'authenticated', session, csrfToken: 'csrf-1' });
  });

  it('creates a browser session when none can be restored', async () => {
    const responses: Response[] = [
      new Response(null, { status: 401 }),
      Response.json({ session, csrfToken: 'csrf-created' }, { status: 201 }),
    ];
    let calls = 0;
    const result = await bootstrapSession(() => Promise.resolve(responses[calls++]!));
    expect(result).toEqual({ status: 'authenticated', session, csrfToken: 'csrf-created' });
    expect(calls).toBe(2);
  });

  it('treats an unavailable session as anonymous without blocking the app', async () => {
    const result = await bootstrapSession(responseFetcher(new Response(null, { status: 404 })));
    expect(result).toEqual({ status: 'anonymous', session: null });
  });

  it('stays anonymous when session creation fails', async () => {
    const responses: Response[] = [
      new Response(null, { status: 401 }),
      new Response(null, { status: 503 }),
    ];
    let calls = 0;
    const result = await bootstrapSession(() => Promise.resolve(responses[calls++]!));
    expect(result).toEqual({ status: 'anonymous', session: null });
    expect(calls).toBe(2);
  });

  it('reports transport failures without exposing the exception', async () => {
    const result = await bootstrapSession(() =>
      Promise.reject(new Error('private transport detail')),
    );
    expect(result.status).toBe('error');
    expect(result.session).toBeNull();
    expect(result.message).toContain('Session bootstrap failed');
    expect(result.message).not.toContain('private transport detail');
  });
});
