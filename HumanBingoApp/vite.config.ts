import { defineConfig, loadEnv, type ProxyOptions, type UserConfig } from 'vite';

const endpointPath = (value: string | undefined, fallback: string, name: string): string => {
  const path = (value?.trim() || fallback).replace(/^\/+|\/+$/g, '');
  if (!path || path.includes('://') || path.includes('?') || path.includes('#')) {
    throw new Error(`${name} must be an endpoint path`);
  }
  return `/${path}`;
};

const port = (value: string | undefined, fallback: number, name: string): number => {
  const result = Number(value?.trim() || fallback);
  if (!Number.isInteger(result) || result < 1 || result > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return result;
};

const target = (value: string | undefined): string => {
  const result = value?.trim() || 'http://127.0.0.1:3000';
  let url: URL;
  try {
    url = new URL(result);
  } catch {
    throw new Error('API_PROXY_TARGET must be a valid HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('API_PROXY_TARGET must be a valid HTTP(S) URL');
  return url.origin;
};

export default defineConfig(({ mode }): UserConfig => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiPath = endpointPath(env.API_PATH, '/api', 'API_PATH');
  const wsPath = endpointPath(env.WS_PATH, '/ws', 'WS_PATH');
  const apiTarget = target(env.API_PROXY_TARGET);
  const proxy: Record<string, ProxyOptions> = {
    [apiPath]: { target: apiTarget, changeOrigin: true },
    [wsPath]: { target: apiTarget, changeOrigin: true, ws: true },
  };

  return {
    root: 'packages/browser-client',
    server: {
      host: env.BROWSER_HOST || '127.0.0.1',
      port: port(env.BROWSER_DEV_PORT, 5173, 'BROWSER_DEV_PORT'),
      proxy,
    },
    preview: {
      host: env.PREVIEW_HOST || '127.0.0.1',
      port: port(env.PREVIEW_PORT, 4173, 'PREVIEW_PORT'),
      proxy,
    },
    define: { __BUILD_ID__: JSON.stringify(env.BUILD_ID || 'development') },
    build: {
      outDir: 'dist-web',
      emptyOutDir: true,
      manifest: true,
    },
  };
});
