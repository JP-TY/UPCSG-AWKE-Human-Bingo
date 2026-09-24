export interface SecurityHeaderOptions {
  readonly production?: boolean;
  readonly connectSources?: readonly string[];
}

/** Headers shared by API responses and the static web edge. */
export function securityHeaders(options: SecurityHeaderOptions = {}): Headers {
  const connectSources = ["'self'", 'wss:', ...(options.connectSources ?? [])]
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(' ');
  const headers = new Headers({
    'content-security-policy': [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      `connect-src ${connectSources}`,
      "worker-src 'self'",
    ].join('; '),
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  });
  if (options.production !== false) {
    headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
  return headers;
}

export function mergeSecurityHeaders(
  headers: Headers,
  options: SecurityHeaderOptions = {},
): Headers {
  const merged = securityHeaders(options);
  for (const [name, value] of headers.entries()) merged.set(name, value);
  return merged;
}
