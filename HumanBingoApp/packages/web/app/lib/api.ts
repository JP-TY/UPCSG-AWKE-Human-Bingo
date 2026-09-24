import type { CreateGameResult, GameId, GameMutationResult } from './types';

interface ApiErrorDto {
  readonly code?: string;
  readonly message?: string;
  readonly retryable?: boolean;
}

export class HumanBingoApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'HumanBingoApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function apiFetch<Value>(path: string, init: RequestInit = {}): Promise<Value> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'include',
    cache: 'no-store',
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
    const apiError = error as ApiErrorDto | undefined;
    throw new HumanBingoApiError(
      typeof apiError?.message === 'string'
        ? apiError.message
        : 'We could not complete that game action. Please try again.',
      response.status,
      typeof apiError?.code === 'string' ? apiError.code : undefined,
      apiError?.retryable === true,
    );
  }

  return payload as Value;
}

async function getCsrfToken(): Promise<string> {
  try {
    const session = await apiFetch<{ csrfToken?: string }>('/api/session');
    if (typeof session.csrfToken === 'string') return session.csrfToken;
  } catch (error) {
    if (!(error instanceof HumanBingoApiError) || error.status !== 401) throw error;
  }

  const created = await apiFetch<{ csrfToken?: string }>('/api/session', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (typeof created.csrfToken !== 'string') {
    throw new HumanBingoApiError('The host session could not be prepared. Please retry.', 500);
  }
  return created.csrfToken;
}

const newIdempotencyKey = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export async function mutateApi<Value>(
  path: string,
  body: Record<string, unknown>,
  method: 'POST' | 'PATCH' = 'POST',
): Promise<Value> {
  const csrfToken = await getCsrfToken();
  return apiFetch<Value>(path, {
    method,
    headers: {
      'X-CSRF-Token': csrfToken,
      'Idempotency-Key': newIdempotencyKey(),
    },
    body: JSON.stringify(body),
  });
}

export async function createGame(name: string): Promise<CreateGameResult> {
  return mutateApi<CreateGameResult>('/api/games', { name });
}

export async function mutateGame(
  gameId: GameId | string,
  command: Record<string, unknown> & { readonly knownStateVersion: number },
): Promise<GameMutationResult> {
  return mutateApi<GameMutationResult>(
    `/api/games/${encodeURIComponent(String(gameId))}`,
    command,
    'PATCH',
  );
}

export function rememberGame(gameId: string, displayName: string, role: 'host' | 'player'): void {
  try {
    localStorage.setItem('human-bingo:last-game', JSON.stringify({ gameId, displayName, role }));
  } catch {
    // The current session still works when browser storage is unavailable.
  }
}

export function realtimeBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_WS_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');

  const origin = new URL(window.location.origin);
  if (process.env.NODE_ENV !== 'production' && origin.port === '3001') {
    origin.port = '3000';
  }
  origin.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  origin.pathname = '/ws';
  origin.search = '';
  return origin.toString().replace(/\/$/, '');
}
