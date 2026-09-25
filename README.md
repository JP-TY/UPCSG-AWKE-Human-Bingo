# UPCSG-AWKE Human Bingo

Human Bingo is a TypeScript event game platform built for UPCSG-AWKE: attendees
fill bingo squares by meeting people and verifying encounters, with a host desk,
live game rooms, leaderboards, push notifications, and face-stamp verification
marks backed by an 11-bag persistence model.

- **Live event app:** Next.js 16 App Router storefront in the AKWE 2026
  scrapbook identity (`HumanBingoApp/packages/web`)
- **Game backend:** Node HTTP + WebSocket API, domain rules, PostgreSQL
  persistence, outbox-relay worker (`HumanBingoApp/packages/{api,domain,persistence,worker}`)
- **Cloud deployment:** AWS CDK stack — ECS Fargate + ALB + CloudFront (public
  HTTPS) + private RDS PostgreSQL 16 (`HumanBingoApp/infra`)

## Repository layout

```
.
├── README.md                  ← you are here
├── .gitignore
├── artifacts/                 ← review screenshots (akwe-*.png)
└── HumanBingoApp/             ← the application workspace
    ├── README.md              ← full developer guide (setup, scripts, DB, troubleshooting)
    ├── docs/
    │   ├── deployment.md      ← detailed deployment guide (local, Compose, AWS CDK, runbook)
    │   └── testing.md         ← test suites and database/browser test setup
    ├── packages/
    │   ├── web/               ← Next.js storefront (/, /host, /join, /invite/[token], /game/[gameId]…)
    │   ├── api/               ← HTTP API + realtime gateway + verification state machine
    │   ├── domain/            ← pure game rules (grids, completion, outbox contracts)
    │   ├── persistence/       ← repositories, migrations, transaction adapters
    │   ├── browser-client/    ← legacy Vite SPA (kept until Next.js flows verify in prod)
    │   ├── worker/            ← outbox relay / push worker
    │   └── test-utils/        ← shared fixtures and DB test helpers
    ├── infra/                 ← AWS CDK app (ECS + ALB + CloudFront + RDS)
    ├── containers/            ← production Dockerfiles (web-next, api, worker)
    ├── deploy/compose.yml     ← production-like packaging (validation, not hosting)
    ├── ops/                   ← nginx, security headers, backup/PITR examples
    ├── scripts/               ← dev bootstrap, DB commands, migrate, backup, outbox replay
    └── tests/                 ← unit, property (fast-check), integration, browser (Playwright)
```

## Quickstart (local)

Prerequisites: Node.js 20+ (CI uses 22), npm, Docker Engine + Compose,
`psql`/`pg_isready` on `PATH`.

```sh
cd HumanBingoApp
npm install
cp .env.example .env
npm run validate:environment
docker compose up -d postgres
node scripts/dev-bootstrap.mjs --target development
npm run dev          # legacy API + Vite client (:5173 → API :3000)
npm run dev:web      # Next.js storefront (rewrites /api/* to the API)
```

Health: `curl -i http://127.0.0.1:3000/health` → `{"status":"ok"}`.
Full details (environment table, database commands, troubleshooting) are in
[`HumanBingoApp/README.md`](HumanBingoApp/README.md).

## Verify

```sh
cd HumanBingoApp
npm run typecheck && npm run lint
npm run test:unit && npm run test:property
npm run test:integration
npm run test:browser && npm run test:accessibility
```

See [`HumanBingoApp/docs/testing.md`](HumanBingoApp/docs/testing.md) for the
isolated test-database setup and Playwright/Chromium notes.

## Deploy (public HTTPS URL)

The only supported public deployment is the CDK stack, which provisions VPC,
ECS Fargate services, ALB (3600 s idle timeout for WebSockets), CloudFront,
private RDS PostgreSQL 16, Secrets Manager secrets, logs, and alarms. neither
`deploy/compose.yml` nor CI deploys anything — they only validate packaging.

```sh
cd HumanBingoApp/infra
npm ci
npx cdk bootstrap        # once per account/region
npm run synth && npm run diff
npm run deploy           # AppUrl output = the public https://… event URL
```

Step-by-step instructions, capacity profile, scaling constraint (keep the API
at 1 task until shared WebSocket fan-out exists), operations runbook
(migrate/backup/outbox replay), and troubleshooting are in
[`HumanBingoApp/docs/deployment.md`](HumanBingoApp/docs/deployment.md).

## Scaling constraint (load-bearing)

The API/realtime gateway fans out **process-locally**. Do not raise the API
task count above one without adding shared fan-out (e.g. Redis pub/sub), or
live game updates will split across tasks. The Next.js web tier (2 → 4 tasks)
is safe to scale.

## Contributing

- Never commit `.env` or real credentials (root + `HumanBingoApp/.gitignore`
  enforce this; generated output — `node_modules`, `.next`, `coverage`,
  `cdk.out`, `dist`, `test-results` — is also ignored).
- Branch per change, open a PR against `main` (`Closes #<issue>`), squash-merge.
- `npm run typecheck`, `npm run lint`, and the affected test suites must pass.
