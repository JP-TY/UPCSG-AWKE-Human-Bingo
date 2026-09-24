import { DomainErrorCode, HumanBingoError } from '@human-bingo/domain';

export type MetricValue = string | number | boolean;
export type MetricLabels = Readonly<Record<string, string>>;

export interface LogContext {
  readonly correlationId?: string;
  readonly requestId?: string;
  readonly gameId?: string;
  readonly participantId?: string;
  readonly command?: string;
  readonly durationMs?: number;
  readonly errorCode?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface StructuredLogRecord extends LogContext {
  readonly timestamp: string;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly event: string;
}

export interface StructuredLogger {
  readonly debug: (event: string, context?: LogContext) => void;
  readonly info: (event: string, context?: LogContext) => void;
  readonly warn: (event: string, context?: LogContext) => void;
  readonly error: (event: string, context?: LogContext) => void;
}

export type LogSink = (record: StructuredLogRecord) => void;

const SENSITIVE_KEY =
  /(authorization|cookie|credential|password|payload|player[_-]?code|push|secret|session|subscription|token)/i;
const MAX_SAFE_STRING_LENGTH = 256;

function safeString(value: string): string {
  return value.length > MAX_SAFE_STRING_LENGTH
    ? `${value.slice(0, MAX_SAFE_STRING_LENGTH)}…`
    : value;
}

function safeValue(
  value: unknown,
  key?: string,
): MetricValue | readonly unknown[] | Readonly<Record<string, unknown>> | null {
  if (key !== undefined && SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return typeof value === 'string' ? safeString(value) : value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeValue(item));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      output[nestedKey] = safeValue(nestedValue, nestedKey);
    }
    return output;
  }
  return Object.prototype.toString.call(value);
}

export function sanitizeLogContext(context: LogContext = {}): LogContext {
  const metadata = context.metadata === undefined ? undefined : safeValue(context.metadata);
  return {
    ...(context.correlationId === undefined
      ? {}
      : { correlationId: safeString(context.correlationId) }),
    ...(context.requestId === undefined ? {} : { requestId: safeString(context.requestId) }),
    ...(context.gameId === undefined ? {} : { gameId: safeString(context.gameId) }),
    ...(context.participantId === undefined
      ? {}
      : { participantId: safeString(context.participantId) }),
    ...(context.command === undefined ? {} : { command: safeString(context.command) }),
    ...(context.durationMs === undefined ? {} : { durationMs: context.durationMs }),
    ...(context.errorCode === undefined ? {} : { errorCode: safeString(context.errorCode) }),
    ...(metadata === undefined ? {} : { metadata: metadata as Readonly<Record<string, unknown>> }),
  };
}

export function createStructuredLogger(
  sink: LogSink = (record) => console.log(JSON.stringify(record)),
  now: () => Date = () => new Date(),
): StructuredLogger {
  const write = (
    level: StructuredLogRecord['level'],
    event: string,
    context: LogContext = {},
  ): void => {
    sink({
      timestamp: now().toISOString(),
      level,
      event: safeString(event),
      ...sanitizeLogContext(context),
    });
  };
  return {
    debug: (event, context) => write('debug', event, context),
    info: (event, context) => write('info', event, context),
    warn: (event, context) => write('warn', event, context),
    error: (event, context) => write('error', event, context),
  };
}

export interface MetricsSink {
  readonly increment: (name: string, labels?: MetricLabels, value?: number) => void;
  readonly observe: (name: string, value: number, labels?: MetricLabels) => void;
}

export interface MetricSnapshot {
  readonly counters: Readonly<Record<string, number>>;
  readonly observations: Readonly<Record<string, readonly number[]>>;
}

function metricKey(name: string, labels: MetricLabels = {}): string {
  const suffix = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
  return suffix.length === 0 ? name : `${name}{${suffix}}`;
}

export class InMemoryMetrics implements MetricsSink {
  readonly #counters = new Map<string, number>();
  readonly #observations = new Map<string, number[]>();

  public increment(name: string, labels: MetricLabels = {}, value = 1): void {
    if (!Number.isFinite(value) || value < 0)
      throw new RangeError('Metric increments must be non-negative and finite');
    const key = metricKey(name, labels);
    this.#counters.set(key, (this.#counters.get(key) ?? 0) + value);
  }

  public observe(name: string, value: number, labels: MetricLabels = {}): void {
    if (!Number.isFinite(value) || value < 0)
      throw new RangeError('Metric observations must be non-negative and finite');
    const key = metricKey(name, labels);
    const values = this.#observations.get(key) ?? [];
    values.push(value);
    this.#observations.set(key, values);
  }

  public snapshot(): MetricSnapshot {
    return {
      counters: Object.fromEntries(this.#counters),
      observations: Object.fromEntries(
        [...this.#observations.entries()].map(([key, values]) => [key, [...values]]),
      ),
    };
  }
}

export interface AuthorizationDenialAuditEvent {
  readonly event: 'authorization.denied';
  readonly timestamp: string;
  readonly correlationId?: string;
  readonly requestId?: string;
  readonly gameId?: string;
  readonly participantId?: string;
  readonly resource: string;
  readonly reason: string;
}

export interface AuditSink {
  readonly record: (event: AuthorizationDenialAuditEvent) => void;
}

export class InMemoryAuditSink implements AuditSink {
  readonly #events: AuthorizationDenialAuditEvent[] = [];

  public record(event: AuthorizationDenialAuditEvent): void {
    this.#events.push({ ...event });
  }

  public events(): readonly AuthorizationDenialAuditEvent[] {
    return this.#events.map((event) => ({ ...event }));
  }
}

export interface Observability {
  readonly logger: StructuredLogger;
  readonly metrics: MetricsSink;
  readonly audit: AuditSink;
  readonly now: () => Date;
}

export interface ObservabilityOptions {
  readonly logger?: StructuredLogger;
  readonly metrics?: MetricsSink;
  readonly audit?: AuditSink;
  readonly now?: () => Date;
}

export function createObservability(options: ObservabilityOptions = {}): Observability {
  const now = options.now ?? (() => new Date());
  return {
    logger: options.logger ?? createStructuredLogger(undefined, now),
    metrics: options.metrics ?? new InMemoryMetrics(),
    audit: options.audit ?? new InMemoryAuditSink(),
    now,
  };
}

export interface CommandObservation {
  readonly correlationId: string;
  readonly command: string;
  readonly gameId?: string;
}

export async function observeCommand<Value>(
  observability: Observability | undefined,
  observation: CommandObservation,
  action: () => Promise<Value>,
): Promise<Value> {
  if (observability === undefined) return action();
  const startedAt = observability.now().getTime();
  const labels = { command: observation.command };
  observability.metrics.increment('human_bingo_command_started_total', labels);
  try {
    const value = await action();
    const durationMs = Math.max(0, observability.now().getTime() - startedAt);
    observability.metrics.increment('human_bingo_command_succeeded_total', labels);
    observability.metrics.observe('human_bingo_command_duration_ms', durationMs, labels);
    observability.logger.info('command.completed', {
      correlationId: observation.correlationId,
      command: observation.command,
      ...(observation.gameId === undefined ? {} : { gameId: observation.gameId }),
      durationMs,
    });
    return value;
  } catch (error: unknown) {
    const durationMs = Math.max(0, observability.now().getTime() - startedAt);
    const errorCode = error instanceof HumanBingoError ? error.code : 'INTERNAL_ERROR';
    observability.metrics.increment('human_bingo_command_failed_total', {
      ...labels,
      code: errorCode,
    });
    observability.metrics.observe('human_bingo_command_duration_ms', durationMs, labels);
    if (errorCode === DomainErrorCode.StaleState) {
      observability.metrics.increment('human_bingo_stale_command_total', labels);
    }
    observability.logger.error('command.failed', {
      correlationId: observation.correlationId,
      command: observation.command,
      ...(observation.gameId === undefined ? {} : { gameId: observation.gameId }),
      durationMs,
      errorCode,
    });
    throw error;
  }
}

export interface RequestObservation extends CommandObservation {
  readonly requestId: string;
  readonly method: string;
  readonly route: string;
}

export async function observeRequest<Value>(
  observability: Observability | undefined,
  observation: RequestObservation,
  action: () => Promise<Value>,
): Promise<Value> {
  if (observability === undefined) return action();
  const startedAt = observability.now().getTime();
  const labels = { method: observation.method, route: observation.route };
  observability.metrics.increment('human_bingo_request_started_total', labels);
  try {
    const value = await action();
    const durationMs = Math.max(0, observability.now().getTime() - startedAt);
    observability.metrics.increment('human_bingo_request_succeeded_total', labels);
    observability.metrics.observe('human_bingo_request_duration_ms', durationMs, labels);
    observability.logger.info('request.completed', {
      correlationId: observation.correlationId,
      requestId: observation.requestId,
      command: observation.command,
      ...(observation.gameId === undefined ? {} : { gameId: observation.gameId }),
      durationMs,
      metadata: { method: observation.method, route: observation.route },
    });
    return value;
  } catch (error: unknown) {
    const durationMs = Math.max(0, observability.now().getTime() - startedAt);
    const errorCode = error instanceof HumanBingoError ? error.code : 'INTERNAL_ERROR';
    observability.metrics.increment('human_bingo_request_failed_total', {
      ...labels,
      code: errorCode,
    });
    observability.metrics.observe('human_bingo_request_duration_ms', durationMs, labels);
    observability.logger.error('request.failed', {
      correlationId: observation.correlationId,
      requestId: observation.requestId,
      command: observation.command,
      ...(observation.gameId === undefined ? {} : { gameId: observation.gameId }),
      durationMs,
      errorCode,
      metadata: { method: observation.method, route: observation.route },
    });
    throw error;
  }
}

export function recordAuthorizationDenial(
  observability: Observability | undefined,
  input: Omit<AuthorizationDenialAuditEvent, 'event' | 'timestamp'>,
): void {
  if (observability === undefined) return;
  const event: AuthorizationDenialAuditEvent = {
    event: 'authorization.denied',
    timestamp: observability.now().toISOString(),
    ...input,
    reason: safeString(input.reason),
    resource: safeString(input.resource),
  };
  observability.audit.record(event);
  observability.metrics.increment('human_bingo_authorization_denied_total', {
    resource: event.resource,
  });
  observability.logger.warn('authorization.denied', {
    ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
    ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
    ...(event.gameId === undefined ? {} : { gameId: event.gameId }),
    ...(event.participantId === undefined ? {} : { participantId: event.participantId }),
    metadata: { resource: event.resource, reason: event.reason },
  });
}

export function recordSynchronization(
  observability: Observability | undefined,
  input: {
    readonly gameId: string;
    readonly participantId?: string;
    readonly durationMs: number;
    readonly outcome: 'success' | 'failure';
  },
): void {
  if (observability === undefined) return;
  const labels = { outcome: input.outcome };
  observability.metrics.increment('human_bingo_synchronization_total', labels);
  observability.metrics.observe(
    'human_bingo_synchronization_duration_ms',
    input.durationMs,
    labels,
  );
  observability.logger.info('synchronization.completed', {
    gameId: input.gameId,
    ...(input.participantId === undefined ? {} : { participantId: input.participantId }),
    durationMs: input.durationMs,
    metadata: { outcome: input.outcome },
  });
}

export function recordEventDelivery(
  observability: Observability | undefined,
  input: {
    readonly gameId: string;
    readonly eventId: string;
    readonly durationMs: number;
    readonly outcome: 'delivered' | 'failed';
  },
): void {
  if (observability === undefined) return;
  const labels = { outcome: input.outcome };
  observability.metrics.increment('human_bingo_event_delivery_total', labels);
  observability.metrics.observe('human_bingo_event_delivery_duration_ms', input.durationMs, labels);
  observability.logger.info('event.delivery.completed', {
    gameId: input.gameId,
    durationMs: input.durationMs,
    metadata: { eventId: input.eventId, outcome: input.outcome },
  });
}

export function recordPushFailure(
  observability: Observability | undefined,
  input: { readonly gameId: string; readonly participantId?: string; readonly reason: string },
): void {
  if (observability === undefined) return;
  observability.metrics.increment('human_bingo_push_failure_total', {
    reason: safeString(input.reason),
  });
  observability.logger.warn('push.delivery.failed', {
    gameId: input.gameId,
    ...(input.participantId === undefined ? {} : { participantId: input.participantId }),
    metadata: { reason: safeString(input.reason) },
  });
}

export interface SafeErrorReport {
  readonly code: string;
  readonly correlationId?: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly httpStatus: number;
}

export function toSafeErrorReport(error: unknown, fallbackCorrelationId?: string): SafeErrorReport {
  if (error instanceof HumanBingoError) {
    return {
      code: error.code,
      correlationId: error.correlationId,
      message: error.message,
      retryable: error.retryable,
      httpStatus: error.httpStatus,
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    ...(fallbackCorrelationId === undefined ? {} : { correlationId: fallbackCorrelationId }),
    message: 'An unexpected error occurred. Please try again.',
    retryable: true,
    httpStatus: 500,
  };
}

export function reportSafeError(
  observability: Observability | undefined,
  error: unknown,
  context: Pick<LogContext, 'correlationId' | 'requestId' | 'gameId' | 'command'> = {},
): SafeErrorReport {
  const report = toSafeErrorReport(error, context.correlationId);
  if (observability !== undefined) {
    observability.logger.error('application.error', {
      ...context,
      errorCode: report.code,
      metadata: { retryable: report.retryable, httpStatus: report.httpStatus },
    });
  }
  return report;
}

export interface HealthCheck {
  readonly name: string;
  readonly check: () => Promise<void>;
}

export interface HealthCheckResult {
  readonly name: string;
  readonly status: 'ok' | 'failed';
  readonly durationMs: number;
}

export interface HealthReport {
  readonly status: 'ok' | 'failed';
  readonly checks: readonly HealthCheckResult[];
  readonly timestamp: string;
}

export class HealthService {
  public constructor(
    private readonly checks: readonly HealthCheck[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  public liveness(): HealthReport {
    return { status: 'ok', checks: [], timestamp: this.now().toISOString() };
  }

  public async readiness(): Promise<HealthReport> {
    const results = await Promise.all(
      this.checks.map(async (check): Promise<HealthCheckResult> => {
        const startedAt = this.now().getTime();
        try {
          await check.check();
          return {
            name: check.name,
            status: 'ok',
            durationMs: Math.max(0, this.now().getTime() - startedAt),
          };
        } catch {
          return {
            name: check.name,
            status: 'failed',
            durationMs: Math.max(0, this.now().getTime() - startedAt),
          };
        }
      }),
    );
    return {
      status: results.every((result) => result.status === 'ok') ? 'ok' : 'failed',
      checks: results,
      timestamp: this.now().toISOString(),
    };
  }
}
