import { mountApp, renderApplicationError } from './app.js';

export {
  bootstrapSession,
  createApp,
  matchRoute,
  mountApp,
  renderApplicationError,
} from './app.js';
export type {
  AppController,
  AppOptions,
  AppRoute,
  SessionFetcher,
  SessionState,
  SessionStatus,
} from './app.js';
export {
  createAlert,
  createButton,
  createDialog,
  createStatusToken,
  designSystemCss,
  getStatusToken,
  installDesignSystem,
} from './design-system.js';
export type {
  AlertOptions,
  AlertTone,
  ButtonOptions,
  ButtonTone,
  DialogOptions,
  StatusToken,
} from './design-system.js';
export { browserEndpoints, resolveBrowserEndpoints } from './endpoints.js';
export type { BrowserEndpointEnvironment, BrowserEndpoints } from './endpoints.js';
export { enableBrowserPush, registerBrowserPush } from './push.js';
export type {
  BrowserNotificationApi,
  BrowserPushManager,
  BrowserPushSubscription,
  BrowserServiceWorkerContainer,
  BrowserServiceWorkerRegistration,
  PushBrowserEnvironment,
  PushPermissionState,
  PushRegistrationResult,
  PushSubscriptionRegistrar,
  RegisterBrowserPushInput,
} from './push.js';
export { createMemberView } from './member-view.js';
export type { MemberSessionView, MemberViewActions, MemberViewState } from './member-view.js';
export { RealtimeGameSocket, defaultRealtimeBackoff } from './realtime-client.js';
export type {
  RealtimeBackoffOptions,
  RealtimeClientOptions,
  RealtimeSocketLike,
  RealtimeSocketStatus,
} from './realtime-client.js';
export type {
  GameViewListener,
  NormalizedGameView,
  NormalizedGridView,
  PatchApplyResult,
} from './state.js';
export {
  GameSyncController,
  GameTransportError,
  HttpGameTransport,
  SynchronizationRequiredError,
} from './transport.js';
export type {
  BrowserFetcher,
  RealtimeEventResult,
  SnapshotLoader,
  SyncControlState,
  SyncControllerOptions,
} from './transport.js';

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if ('serviceWorker' in navigator) {
    void navigator.serviceWorker.register('/service-worker.js').catch(() => {
      // In-app notifications remain authoritative when worker registration fails.
    });
  }
  const root = document.getElementById('app');
  if (root) {
    void mountApp(root).catch((error: unknown) => {
      renderApplicationError(root, error);
    });
  }
}
