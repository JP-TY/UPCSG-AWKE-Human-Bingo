import { describe, expect, it } from 'vitest';
import { resolveBrowserEndpoints } from './endpoints.js';

describe('resolveBrowserEndpoints', () => {
  it('uses relative API and origin-derived websocket defaults', () => {
    expect(resolveBrowserEndpoints({}, 'https://play.example')).toEqual({
      apiBaseUrl: 'https://play.example/api',
      wsUrl: 'wss://play.example/ws',
    });
  });

  it('accepts configured absolute endpoints without machine-specific defaults', () => {
    expect(
      resolveBrowserEndpoints(
        { apiBaseUrl: '/backend', wsUrl: 'wss://api.example/realtime' },
        'http://localhost:5173',
      ),
    ).toEqual({
      apiBaseUrl: 'http://localhost:5173/backend',
      wsUrl: 'wss://api.example/realtime',
    });
  });

  it('normalizes configurable endpoint paths', () => {
    expect(
      resolveBrowserEndpoints({ apiPath: 'api/v2', wsPath: '/socket/' }, 'http://127.0.0.1:5173'),
    ).toEqual({
      apiBaseUrl: 'http://127.0.0.1:5173/api/v2',
      wsUrl: 'ws://127.0.0.1:5173/socket',
    });
  });
});
