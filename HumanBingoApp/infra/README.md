# AWS deployment

The CDK stack deploys the Next.js standalone web service and the existing Node HTTP/WebSocket API on ECS Fargate behind an ALB, with PostgreSQL 16 on private RDS. CloudFront gives the event a managed HTTPS `cloudfront.net` URL, so no custom domain is required.

## Capacity profile

- Next.js: 2 Fargate tasks at 0.5 vCPU / 1 GiB, scaling to 4 tasks at 60% CPU.
- API and realtime: 1 Fargate task at 2 vCPU / 4 GiB. This is intentional. The current gateway and retained patches are process-local, so scaling this service horizontally before adding shared fan-out would split live game updates.
- Database: private RDS PostgreSQL 16, `db.t4g.medium`, encrypted storage, 7-day automated backups, and 20 GiB initial storage with autoscaling to 100 GiB.
- ALB idle timeout: 3600 seconds for persistent WebSocket sessions. CloudFront forwards viewer headers, cookies, and query strings; API and WebSocket paths bypass caching.

The single API task is sized for 300 connected attendees, not just 300 short HTTP requests. Run a staging load test with a real joined game and session cookies before the event. Add shared WebSocket fan-out (for example Redis pub/sub) before raising the API task count above one.

## Deploy

Use an AWS account/region configured for CDK, then run:

```sh
cd infra
npm ci
npm run synth
npm run deploy
```

The `AppUrl` stack output is the HTTPS event URL. RDS credentials and the session signing secret are generated in Secrets Manager and injected into the API task. The API task runs the idempotent initial/additive migrations before starting the existing server entrypoint. The Vite SPA and its tests remain in the repository until the Next.js flows have been verified in the deployed environment.

## Local Next.js app

From the `HumanBingoApp` directory, build and serve the standalone Next.js surface with:

```sh
npm run build:web
WEB_PORT=3012 npm run start:web
```

For `npm run dev:web`, the Next.js rewrite sends HTTP `/api/*` requests to `API_PROXY_TARGET` (default `http://127.0.0.1:3000`). The browser connects directly to `WS_URL` for local WebSockets; production `/ws` is routed through the same ALB/CloudFront origin.
