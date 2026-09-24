import type { PushSubscriptionRegistration } from '@human-bingo/domain';

export type PushPermissionState = 'granted' | 'denied' | 'default' | 'unsupported' | 'error';

export interface BrowserPushSubscription {
  readonly endpoint: string;
  readonly toJSON?: () => unknown;
}

export interface BrowserPushManager {
  readonly subscribe: (options: {
    readonly userVisibleOnly: true;
    readonly applicationServerKey: Uint8Array;
  }) => Promise<BrowserPushSubscription>;
}

export interface BrowserServiceWorkerRegistration {
  readonly pushManager?: BrowserPushManager;
}

export interface BrowserServiceWorkerContainer {
  readonly ready: Promise<BrowserServiceWorkerRegistration>;
}

export interface BrowserNotificationApi {
  readonly permission: NotificationPermission;
  readonly requestPermission: () => Promise<NotificationPermission>;
}

export interface PushBrowserEnvironment {
  readonly notifications?: BrowserNotificationApi;
  readonly serviceWorker?: BrowserServiceWorkerContainer;
}

export interface PushRegistrationResult {
  readonly status: PushPermissionState;
  readonly subscription?: PushSubscriptionRegistration;
  readonly message?: string;
}

export interface RegisterBrowserPushInput {
  readonly vapidPublicKey: string;
  readonly environment?: PushBrowserEnvironment;
}

export async function registerBrowserPush(
  input: RegisterBrowserPushInput,
): Promise<PushRegistrationResult> {
  const notifications = input.environment?.notifications ?? defaultNotifications();
  const serviceWorker = input.environment?.serviceWorker ?? defaultServiceWorker();
  if (notifications === undefined || serviceWorker === undefined) {
    return { status: 'unsupported', message: 'Browser push is not supported.' };
  }

  let permission: NotificationPermission;
  try {
    permission =
      notifications.permission === 'default'
        ? await notifications.requestPermission()
        : notifications.permission;
  } catch {
    return { status: 'error', message: 'Push permission could not be requested.' };
  }
  if (permission !== 'granted') {
    return {
      status: permission === 'denied' ? 'denied' : 'default',
      message:
        permission === 'denied'
          ? 'Browser notifications are denied; in-app notifications remain available.'
          : 'Notification permission is required for browser push.',
    };
  }

  try {
    const registration = await serviceWorker.ready;
    if (registration.pushManager === undefined) {
      return { status: 'unsupported', message: 'Browser push is not supported.' };
    }
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeBase64Url(input.vapidPublicKey),
    });
    return { status: 'granted', subscription: subscriptionRegistration(subscription) };
  } catch {
    return { status: 'error', message: 'Browser push registration failed.' };
  }
}

export interface PushSubscriptionRegistrar {
  register(subscription: PushSubscriptionRegistration): Promise<void>;
}

/** Registers the browser subscription only after permission and subscription succeed. */
export async function enableBrowserPush(
  input: RegisterBrowserPushInput,
  registrar: PushSubscriptionRegistrar,
): Promise<PushRegistrationResult> {
  const result = await registerBrowserPush(input);
  if (result.subscription === undefined) return result;
  try {
    await registrar.register(result.subscription);
    return result;
  } catch {
    return { status: 'error', message: 'The push subscription could not be saved.' };
  }
}

function subscriptionRegistration(
  subscription: BrowserPushSubscription,
): PushSubscriptionRegistration {
  const serialized = subscription.toJSON?.();
  const candidate =
    typeof serialized === 'object' && serialized !== null
      ? (serialized as Record<string, unknown>)
      : {};
  const p256dh =
    typeof candidate.keys === 'object' && candidate.keys !== null
      ? (candidate.keys as Record<string, unknown>).p256dh
      : undefined;
  const auth =
    typeof candidate.keys === 'object' && candidate.keys !== null
      ? (candidate.keys as Record<string, unknown>).auth
      : undefined;
  if (
    typeof subscription.endpoint !== 'string' ||
    typeof p256dh !== 'string' ||
    typeof auth !== 'string'
  ) {
    throw new TypeError('The browser returned an incomplete push subscription');
  }
  return { endpoint: subscription.endpoint, p256dh, auth };
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError('The VAPID public key is invalid');
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(`${value.replace(/-/g, '+').replace(/_/g, '/')}${padding}`);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function defaultNotifications(): BrowserNotificationApi | undefined {
  if (typeof Notification === 'undefined') return undefined;
  return {
    permission: Notification.permission,
    requestPermission: () => Notification.requestPermission(),
  };
}

function defaultServiceWorker(): BrowserServiceWorkerContainer | undefined {
  if (typeof navigator === 'undefined' || navigator.serviceWorker === undefined) return undefined;
  return navigator.serviceWorker;
}
