import { DomainErrorCode, HumanBingoError } from '@human-bingo/domain';

export interface InputLimits {
  readonly requestBytes: number;
  readonly gameName: number;
  readonly taskText: number;
  readonly displayName: number;
  readonly playerCode: number;
  readonly idempotencyKey: number;
  readonly invitationToken: number;
}

export const defaultInputLimits: InputLimits = {
  requestBytes: 64 * 1024,
  gameName: 200,
  taskText: 500,
  displayName: 100,
  playerCode: 64,
  idempotencyKey: 128,
  invitationToken: 512,
};

export class SecurityValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SecurityValidationError';
  }
}

export const assertByteLength = (value: string, limit: number, field: string): void => {
  if (!Number.isInteger(limit) || limit <= 0)
    throw new RangeError('Input limits must be positive integers');
  if (Buffer.byteLength(value, 'utf8') > limit) {
    throw new SecurityValidationError(`${field} exceeds its maximum size`);
  }
};

export const assertRequestBodySize = (
  body: string | Uint8Array,
  limit = defaultInputLimits.requestBytes,
): void => {
  const size = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength;
  if (size > limit) throw new SecurityValidationError('Request body exceeds its maximum size');
};

export const validateInputLimits = (
  input: Readonly<Record<string, string | undefined>>,
  limits: InputLimits = defaultInputLimits,
): void => {
  const fields: readonly [keyof InputLimits, string][] = [
    ['gameName', 'name'],
    ['taskText', 'text'],
    ['displayName', 'displayName'],
    ['playerCode', 'playerCode'],
    ['idempotencyKey', 'idempotencyKey'],
    ['invitationToken', 'token'],
  ];
  for (const [limitKey, field] of fields) {
    const value = input[field];
    if (value !== undefined) assertByteLength(value, limits[limitKey], field);
  }
};

export interface CorsHeaders {
  readonly 'access-control-allow-origin': string;
  readonly 'access-control-allow-credentials': 'true';
  readonly vary: 'Origin';
}

export class OriginPolicy {
  readonly #allowedOrigins: ReadonlySet<string>;

  public constructor(allowedOrigins: readonly string[]) {
    if (allowedOrigins.includes('*'))
      throw new SecurityValidationError('Wildcard origins are not allowed');
    let normalized: string[];
    try {
      normalized = allowedOrigins.map((origin) => new URL(origin).origin);
    } catch {
      throw new SecurityValidationError('Allowed origins must be valid absolute URLs');
    }
    this.#allowedOrigins = new Set(normalized);
  }

  public allows(origin: string | undefined): boolean {
    if (origin === undefined) return false;
    try {
      return this.#allowedOrigins.has(new URL(origin).origin) && origin === new URL(origin).origin;
    } catch {
      return false;
    }
  }

  public headers(origin: string | undefined): CorsHeaders | null {
    if (!this.allows(origin)) return null;
    return {
      'access-control-allow-origin': new URL(origin as string).origin,
      'access-control-allow-credentials': 'true',
      vary: 'Origin',
    };
  }
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterMs: number;
}

export interface RateLimiterOptions {
  readonly limit: number;
  readonly windowMs: number;
  readonly now?: () => number;
}

interface Counter {
  count: number;
  windowStartedAt: number;
}

export class InMemoryRateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #counters = new Map<string, Counter>();

  public constructor(options: RateLimiterOptions) {
    if (!Number.isInteger(options.limit) || options.limit <= 0)
      throw new RangeError('Rate limit must be positive');
    if (!Number.isInteger(options.windowMs) || options.windowMs <= 0)
      throw new RangeError('Rate window must be positive');
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? Date.now;
  }

  public consume(key: string): RateLimitDecision {
    const now = this.#now();
    const previous = this.#counters.get(key);
    const counter =
      previous === undefined || now - previous.windowStartedAt >= this.#windowMs
        ? { count: 0, windowStartedAt: now }
        : previous;
    counter.count += 1;
    this.#counters.set(key, counter);
    const allowed = counter.count <= this.#limit;
    return {
      allowed,
      remaining: Math.max(0, this.#limit - counter.count),
      retryAfterMs: allowed ? 0 : Math.max(0, counter.windowStartedAt + this.#windowMs - now),
    };
  }

  public clear(key?: string): void {
    if (key === undefined) this.#counters.clear();
    else this.#counters.delete(key);
  }
}

export const assertParameterizedQuery = (sql: string, values: readonly unknown[] = []): void => {
  if (values.length === 0) return;
  const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
  if (
    placeholders.length === 0 ||
    placeholders.some((value) => !Number.isInteger(value) || value < 1 || value > values.length)
  ) {
    throw new SecurityValidationError('SQL values must be bound through positional parameters');
  }
  if (/[;]--|\/\*/.test(sql)) throw new SecurityValidationError('Unsafe SQL comment sequence');
};

export const rateLimitedError = (retryAfterMs: number): HumanBingoError =>
  new HumanBingoError({
    code: DomainErrorCode.RateLimited,
    message: 'Too many requests; please retry later',
    correlationId: 'rate-limit' as never,
    retryable: true,
    httpStatus: 429,
    metadata: { retryAfterMs },
  });
