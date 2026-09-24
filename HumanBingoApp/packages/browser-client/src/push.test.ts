import { describe, expect, it } from 'vitest';

import { enableBrowserPush, registerBrowserPush, type BrowserPushSubscription } from './push.js';

const vapidPublicKey = 'AQIDBAUGBwgJCgsMDQ4PEA';

function environment(permission: NotificationPermission = 'granted') {
  const subscriptions: Array<{ userVisibleOnly: true; applicationServerKey: Uint8Array }> = [];
  const subscription: BrowserPushSubscription = {
    endpoint: 'https://push.example/subscription/1',
    toJSON: () => ({
      endpoint: 'https://push.example/subscription/1',
      keys: { p256dh: 'abcdefghijklmnopqrstuvwxyz01', auth: 'abcdefghijklmnopqrstuvwxyz02' },
    }),
  };
  return {
    subscriptions,
    environment: {
      notifications: {
        permission,
        requestPermission: () => Promise.resolve('granted' as NotificationPermission),
      },
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: {
            subscribe: (options: { userVisibleOnly: true; applicationServerKey: Uint8Array }) => {
              subscriptions.push(options);
              return Promise.resolve(subscription);
            },
          },
        }),
      },
    },
  };
}

describe('browser push registration', () => {
  it('requests permission and returns the browser subscription for API registration', async () => {
    const fixture = environment('default');
    const result = await registerBrowserPush({ vapidPublicKey, environment: fixture.environment });

    expect(result.status).toBe('granted');
    expect(result.subscription).toEqual({
      endpoint: 'https://push.example/subscription/1',
      p256dh: 'abcdefghijklmnopqrstuvwxyz01',
      auth: 'abcdefghijklmnopqrstuvwxyz02',
    });
    expect(fixture.subscriptions[0]?.userVisibleOnly).toBe(true);
  });

  it('keeps in-app notification fallback when permission is denied or APIs are unavailable', async () => {
    const denied = await registerBrowserPush({
      vapidPublicKey,
      environment: environment('denied').environment,
    });
    expect(denied).toMatchObject({ status: 'denied' });

    const unsupported = await registerBrowserPush({ vapidPublicKey, environment: {} });
    expect(unsupported.status).toBe('unsupported');
  });

  it('does not call the API registrar when subscription creation fails', async () => {
    let calls = 0;
    const fixture = environment();
    const result = await enableBrowserPush(
      {
        vapidPublicKey,
        environment: {
          ...fixture.environment,
          serviceWorker: {
            ready: Promise.resolve({
              pushManager: { subscribe: () => Promise.reject(new Error('blocked')) },
            }),
          },
        },
      },
      {
        register: () => {
          calls += 1;
          return Promise.resolve();
        },
      },
    );

    expect(result.status).toBe('error');
    expect(calls).toBe(0);
  });
});
