import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const apiTarget = (process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000').replace(/\/$/, '');

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.resolve(appDirectory, '../..'),
  transpilePackages: ['@human-bingo/browser-client', '@human-bingo/domain'],
  poweredByHeader: false,
  compress: true,
  images: {
    unoptimized: true,
    formats: ['image/avif', 'image/webp'],
  },
  rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${apiTarget}/api/:path*`,
      },
    ];
  },
  headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
