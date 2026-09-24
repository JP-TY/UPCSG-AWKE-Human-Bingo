export interface WorkerMetrics {
  readonly increment: (
    name: string,
    labels?: Readonly<Record<string, string>>,
    value?: number,
  ) => void;
  readonly observe?: (
    name: string,
    value: number,
    labels?: Readonly<Record<string, string>>,
  ) => void;
}

/** Records best-effort push failures without coupling the service worker to API internals. */
export const recordPushDeliveryFailure = (
  metrics: WorkerMetrics | undefined,
  input: { readonly gameId: string; readonly participantId?: string; readonly reason: string },
): void => {
  if (metrics === undefined) return;
  metrics.increment('human_bingo_push_failure_total', { reason: input.reason });
};

/** Records delivery latency for worker-published realtime events. */
export const recordEventDeliveryTiming = (
  metrics: WorkerMetrics | undefined,
  input: { readonly durationMs: number; readonly outcome: 'delivered' | 'failed' },
): void => {
  if (metrics === undefined) return;
  const labels = { outcome: input.outcome };
  metrics.increment('human_bingo_event_delivery_total', labels);
  metrics.observe?.('human_bingo_event_delivery_duration_ms', input.durationMs, labels);
};
