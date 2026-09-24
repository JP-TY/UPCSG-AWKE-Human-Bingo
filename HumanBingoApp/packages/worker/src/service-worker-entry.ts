import {
  activateServiceWorker,
  installPushEventHandlers,
  type PushClickRuntime,
  type PushDisplayRuntime,
  type ServiceWorkerEventTarget,
  type ServiceWorkerRuntime,
} from './service-worker.js';

interface ServiceWorkerGlobal extends ServiceWorkerEventTarget, ServiceWorkerRuntime {
  readonly location: { readonly origin: string };
  readonly registration: PushDisplayRuntime;
  readonly clients: {
    readonly matchAll: () => Promise<readonly PushClientLike[]>;
    readonly openWindow: (url: string) => Promise<PushClientLike | null>;
    readonly claim: () => Promise<void>;
  };
}

interface PushClientLike {
  readonly url: string;
  readonly focus: () => Promise<void>;
}

const scope = globalThis as unknown as ServiceWorkerGlobal;
const clickRuntime: PushClickRuntime = {
  matchClients: () => scope.clients.matchAll(),
  openWindow: (url) => scope.clients.openWindow(url),
};

activateServiceWorker(scope);
installPushEventHandlers(scope, scope.registration, clickRuntime, scope.location.origin);
