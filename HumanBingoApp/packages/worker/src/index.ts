/** Worker package boundary for outbox and notification jobs. */
export const workerPackage = '@human-bingo/worker';

export { recordEventDeliveryTiming, recordPushDeliveryFailure } from './observability.js';
export type { WorkerMetrics } from './observability.js';
export {
  activateServiceWorker,
  handleNotificationClick,
  handlePushEvent,
  installPushEventHandlers,
} from './service-worker.js';
export type {
  NotificationClickEventLike,
  PushClickRuntime,
  PushClient,
  PushDisplayRuntime,
  PushEventData,
  PushEventLike,
  ServiceWorkerEventTarget,
  ServiceWorkerRuntime,
} from './service-worker.js';
export { IdempotentEventConsumer, OutboxPublisher, OutboxWorkConsumer } from './outbox.js';
export type {
  EventBroker,
  EventConsumerStore,
  OutboxPublishReport,
  OutboxStore,
  OutboxWorkEvent,
  OutboxWorkHandlers,
  PublishableEvent,
} from './outbox.js';
