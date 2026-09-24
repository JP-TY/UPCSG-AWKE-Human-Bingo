import { describe, expect, it } from 'vitest';

import {
  handleNotificationClick,
  handlePushEvent,
  installPushEventHandlers,
  type NotificationClickEventLike,
  type PushEventLike,
} from './service-worker.js';

const appOrigin = 'https://app.example';
const payload = {
  gameName: 'Team Bingo',
  requestingParticipant: 'Alex',
  taskText: 'has a bicycle',
  deepLink: 'https://app.example/game/game-1/notifications?request=request-1',
};

describe('service worker push workflows', () => {
  it('displays safe push content and includes the deep link for click-through', async () => {
    const shown: unknown[] = [];
    let pending: Promise<void> | undefined;
    const event: PushEventLike = {
      data: { json: () => payload },
      waitUntil: (promise) => {
        pending = promise;
      },
    };

    handlePushEvent(
      event,
      {
        showNotification: (title, options) => {
          shown.push({ title, options });
          return Promise.resolve();
        },
      },
      appOrigin,
    );
    await pending;

    expect(shown).toEqual([
      {
        title: 'Team Bingo',
        options: {
          body: 'Alex: has a bicycle',
          data: payload,
        },
      },
    ]);
  });

  it('focuses an existing notification tab before opening a new one', async () => {
    let focused = 0;
    let opened = 0;
    let pending: Promise<void> | undefined;
    const event: NotificationClickEventLike = {
      notification: { data: payload, close: () => undefined },
      waitUntil: (promise) => {
        pending = promise;
      },
    };
    handleNotificationClick(
      event,
      {
        matchClients: () =>
          Promise.resolve([
            {
              url: payload.deepLink,
              focus: () => {
                focused += 1;
                return Promise.resolve();
              },
            },
          ]),
        openWindow: () => {
          opened += 1;
          return Promise.resolve(null);
        },
      },
      appOrigin,
    );
    await pending;

    expect(focused).toBe(1);
    expect(opened).toBe(0);
  });

  it('ignores payloads with foreign or unsafe deep links', async () => {
    let pending: Promise<void> | undefined;
    let shown = 0;
    const event: PushEventLike = {
      data: { json: () => ({ ...payload, deepLink: 'https://evil.example/phishing' }) },
      waitUntil: (promise) => {
        pending = promise;
      },
    };
    handlePushEvent(
      event,
      {
        showNotification: () => {
          shown += 1;
          return Promise.resolve();
        },
      },
      appOrigin,
    );
    await pending;
    expect(shown).toBe(0);
  });

  it('installs push and click handlers on the worker scope', () => {
    const handlers: Record<string, (event: never) => void> = {};
    installPushEventHandlers(
      {
        addEventListener: (type, listener) => {
          handlers[type] = listener as (event: never) => void;
        },
      },
      { showNotification: () => Promise.resolve() },
      { matchClients: () => Promise.resolve([]), openWindow: () => Promise.resolve(null) },
      appOrigin,
    );

    expect(Object.keys(handlers)).toEqual(['push', 'notificationclick']);
  });
});
