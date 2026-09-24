import { isSafeVerificationPushPayload, type VerificationPushPayload } from '@human-bingo/domain';

export interface ServiceWorkerRuntime {
  readonly skipWaiting: () => Promise<void>;
  readonly claimClients: () => Promise<void>;
}

export interface PushDisplayRuntime {
  readonly showNotification: (
    title: string,
    options: { readonly body: string; readonly data: VerificationPushPayload },
  ) => Promise<void>;
}

export interface PushClient {
  readonly url: string;
  readonly focus: () => Promise<void>;
}

export interface PushClickRuntime {
  readonly matchClients: () => Promise<readonly PushClient[]>;
  readonly openWindow: (url: string) => Promise<PushClient | null>;
}

export interface PushEventData {
  readonly json?: () => unknown;
  readonly text?: () => string;
}

export interface PushEventLike {
  readonly data: PushEventData | null;
  readonly waitUntil: (promise: Promise<void>) => void;
}

export interface NotificationClickEventLike {
  readonly notification: {
    readonly data: unknown;
    readonly close: () => void;
  };
  readonly waitUntil: (promise: Promise<void>) => void;
}

export interface ServiceWorkerEventTarget {
  addEventListener(type: 'push', listener: (event: PushEventLike) => void): void;
  addEventListener(
    type: 'notificationclick',
    listener: (event: NotificationClickEventLike) => void,
  ): void;
}

/** Minimal lifecycle adapter; browser event wiring is added with worker workflows. */
export const activateServiceWorker = (runtime: ServiceWorkerRuntime): void => {
  void runtime.skipWaiting();
  void runtime.claimClients();
};

/** Wires browser worker events to the validated delivery and click handlers. */
export function installPushEventHandlers(
  scope: ServiceWorkerEventTarget,
  displayRuntime: PushDisplayRuntime,
  clickRuntime: PushClickRuntime,
  appOrigin: string,
): void {
  scope.addEventListener('push', (event) => handlePushEvent(event, displayRuntime, appOrigin));
  scope.addEventListener('notificationclick', (event) =>
    handleNotificationClick(event, clickRuntime, appOrigin),
  );
}

/**
 * Converts a push event into a visible notification while rejecting payloads
 * from another origin or payloads containing unsafe routes.
 */
export function handlePushEvent(
  event: PushEventLike,
  runtime: PushDisplayRuntime,
  appOrigin: string,
): void {
  event.waitUntil(
    Promise.resolve()
      .then(() => parsePushPayload(event.data, appOrigin))
      .then((payload) => {
        if (payload === null) return;
        return runtime.showNotification(payload.gameName, {
          body: `${payload.requestingParticipant}: ${payload.taskText}`,
          data: payload,
        });
      }),
  );
}

/** Focuses an existing app tab or opens the safe notification deep link. */
export function handleNotificationClick(
  event: NotificationClickEventLike,
  runtime: PushClickRuntime,
  appOrigin: string,
): void {
  event.notification.close();
  event.waitUntil(
    Promise.resolve().then(() => {
      const payload = parsePushPayload(event.notification.data, appOrigin);
      if (payload === null) return;
      return runtime.matchClients().then(async (clients) => {
        const existing = clients.find((client) => client.url === payload.deepLink);
        if (existing !== undefined) {
          await existing.focus();
          return;
        }
        await runtime.openWindow(payload.deepLink);
      });
    }),
  );
}

export const serviceWorkerPackage = '@human-bingo/worker/service-worker';

function parsePushPayload(value: unknown, appOrigin: string): VerificationPushPayload | null {
  let candidate: unknown = value;
  if (value !== null && typeof value === 'object' && ('json' in value || 'text' in value)) {
    const data = value as PushEventData;
    try {
      candidate = data.json?.() ?? (data.text === undefined ? undefined : JSON.parse(data.text()));
    } catch {
      return null;
    }
  }
  return isSafeVerificationPushPayload(candidate, appOrigin) ? candidate : null;
}
