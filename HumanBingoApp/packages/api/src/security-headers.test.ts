import { describe, expect, it } from 'vitest';

import { mergeSecurityHeaders, securityHeaders } from './security-headers.js';

describe('security response headers', () => {
  it('sets restrictive framing, content, transport, and browser capability policies', () => {
    const headers = securityHeaders();

    expect(headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(headers.get('content-security-policy')).toContain("object-src 'none'");
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('strict-transport-security')).toContain('max-age=31536000');
  });

  it('preserves response-specific headers when security headers are merged', () => {
    const headers = mergeSecurityHeaders(new Headers({ 'content-type': 'application/json' }), {
      production: false,
      connectSources: ['https://api.example.test'],
    });

    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('strict-transport-security')).toBeNull();
    expect(headers.get('content-security-policy')).toContain('https://api.example.test');
  });
});
