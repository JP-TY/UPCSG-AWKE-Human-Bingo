export interface BrowserEndpointEnvironment {
  readonly apiBaseUrl?: string;
  readonly wsUrl?: string;
  readonly apiPath?: string;
  readonly wsPath?: string;
}

export interface BrowserEndpoints {
  readonly apiBaseUrl: string;
  readonly wsUrl: string;
}

const path = (value: string | undefined, fallback: string): string => {
  const result = (value?.trim() || fallback).replace(/^\/+|\/+$/g, '');
  if (!result || result.includes('?') || result.includes('#'))
    throw new Error('Endpoint path is invalid');
  return `/${result}`;
};

const absolute = (value: string | undefined, base: URL, fallbackPath: string): string => {
  if (!value?.trim()) return new URL(fallbackPath, base).toString().replace(/\/$/, '');
  return new URL(value, base).toString().replace(/\/$/, '');
};

/** Resolves browser endpoints without assuming a developer machine hostname. */
export const resolveBrowserEndpoints = (
  environment: BrowserEndpointEnvironment = {},
  locationOrigin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
): BrowserEndpoints => {
  const origin = new URL(locationOrigin);
  const apiPath = path(environment.apiPath, '/api');
  const wsPath = path(environment.wsPath, '/ws');
  const apiBaseUrl = absolute(environment.apiBaseUrl, origin, apiPath);
  const configuredWs = environment.wsUrl?.trim();
  if (configuredWs) return { apiBaseUrl, wsUrl: absolute(configuredWs, origin, wsPath) };
  const wsOrigin = new URL(origin);
  wsOrigin.protocol = wsOrigin.protocol === 'https:' ? 'wss:' : 'ws:';
  return { apiBaseUrl, wsUrl: new URL(wsPath, wsOrigin).toString().replace(/\/$/, '') };
};

interface BrowserClientImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_WS_URL?: string;
  readonly VITE_API_PATH?: string;
  readonly VITE_WS_PATH?: string;
}

export const browserEndpoints = (): BrowserEndpoints => {
  const environment = import.meta.env as unknown as BrowserClientImportMetaEnv;
  const configured: BrowserEndpointEnvironment = {
    ...(environment.VITE_API_BASE_URL === undefined
      ? {}
      : { apiBaseUrl: environment.VITE_API_BASE_URL }),
    ...(environment.VITE_WS_URL === undefined ? {} : { wsUrl: environment.VITE_WS_URL }),
    ...(environment.VITE_API_PATH === undefined ? {} : { apiPath: environment.VITE_API_PATH }),
    ...(environment.VITE_WS_PATH === undefined ? {} : { wsPath: environment.VITE_WS_PATH }),
  };
  return resolveBrowserEndpoints(configured);
};
