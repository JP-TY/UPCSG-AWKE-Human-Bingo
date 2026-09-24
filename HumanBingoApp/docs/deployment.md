# Deployment Guide — UPCSG-AWKE Human Bingo

This guide covers every supported way to run Human Bingo: local development,
production-like Docker Compose packaging, and the AWS CDK deployment (ECS
Fargate + ALB + CloudFront + private RDS PostgreSQL 16). It is written against
the repository as merged to `main` (baseline #12 plus features #6–#10).

Related docs: `testing.md` (test suites), `deploy/README.md` (packaging
notes), `infra/README.md` (AWS capacity profile), root `README.md`
(environment setup).

## 1. Architecture overview

```
                    ┌──────────── CloudFront (HTTPS, managed *.cloudfront.net URL)
                    │              forwards viewer headers/cookies/query strings
                    │              API + /ws bypass cache
                    ▼
              ┌────────── ALB (idle timeout 3600s for WebSockets)
              │    /api/* /ws  → API service (Node HTTP + WebSocket gateway)
              │    /*          → Next.js standalone web service
              ▼
 ┌────────────────────────┐   ┌────────────────────────┐
 │ Next.js web (App Router)│   │ API + realtime gateway  │
 │ AKWE 2026 scrapbook UI  │──▶│ + worker (outbox relay) │
 │ 8 routes, design tokens │   │ process-local fan-out   │
 └────────────────────────┘   └───────────┬─────────────┘
                                          ▼
                               ┌────────────────────────┐
                               │ RDS PostgreSQL 16      │
                               │ private subnets,       │
                               │ encrypted, 7-day PITR  │
                               └────────────────────────┘
```

### Packages (`HumanBingoApp/packages/`)

| Package | Role |
|---|---|
| `web` | Next.js 16 App Router storefront (AKWE scrapbook identity), standalone output |
| `api` | HTTP API + WebSocket gateway, game/verification state machine |
| `domain` | Pure game rules (grids, completion, outbox contracts) |
| `persistence` | PostgreSQL repositories, migrations (`001_initial_schema`), transaction adapters |
| `browser-client` | Legacy Vite SPA client (kept until Next.js flows fully verified in prod) |
| `worker` | Outbox relay / push notification worker |
| `test-utils` | Shared fixtures, clock, Postgres test helpers |

### Web routes (`packages/web/app/`)

`/` (landing), `/host`, `/join`, `/invite/[token]`, `/game/[gameId]`,
`/game/[gameId]/host`, `/game/[gameId]/notifications`, `/health`, plus
`icon.png`. API liveness `GET /health` → `{"status":"ok"}`;
readiness `GET /ready` → `{"status":"ready"}` or 503 `not_ready`.

### Scaling constraint (load-bearing)

The API/realtime gateway keeps fan-out **process-local**. The CDK stack
therefore runs exactly **1 API task** (2 vCPU / 4 GiB, sized for ~300
connected attendees). Do **not** raise the API task count without first
adding shared fan-out (e.g. Redis pub/sub) — extra tasks would split live
game updates. Next.js web scales 2 → 4 tasks at 60% CPU and is safe to scale.

## 2. Prerequisites

- Node.js 20+ (CI uses Node 22), npm
- Docker Engine + Compose (local Postgres, packaging checks)
- `psql` + `pg_isready` on `PATH` (database commands)
- Chromium for browser tests (`npm run test:browser:install` or
  `sudo pacman -S chromium` on Arch; override via `PLAYWRIGHT_EXECUTABLE_PATH`)
- AWS path only: AWS CLI v2 + CDK (`npx cdk`), an account/region with
  `aws sts get-caller-identity` working and permission to create
  VPC/ECS/ALB/RDS/CloudFront/SecretsManager resources

## 3. Environment variables

Copy and edit from the example (never commit real secrets):

```sh
cp .env.example .env
npm run validate:environment
```

| Variable | Local default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development` / `test` / `production` |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | API bind; legacy `API_PORT` accepted as fallback |
| `DATABASE_URL` | loopback `human_bingo` URL | App connection; must stay loopback locally |
| `DATABASE_ADMIN_URL` | loopback maintenance URL, no embedded password | Role preflight only |
| `DATABASE_ROLE` / `DATABASE_ROLE_PASSWORD` | `jpty` / placeholder | Created only when absent |
| `TEST_DATABASE_URL` | isolated `human_bingo_test` | Must differ from `DATABASE_URL` |
| `SESSION_SECRET` | placeholder | ≥ 32 chars |
| `PUBLIC_APP_ORIGIN` | `http://localhost:4173` | Public browser origin |
| `DATABASE_SSL_MODE` | `disable` locally | Production requires `verify-full` + HTTPS |
| `API_PROXY_TARGET` | `http://127.0.0.1:3000` | `dev:web` rewrites `/api/*` here |
| `WS_URL` | direct local WS | Browser connects directly locally; via ALB/CloudFront in prod |

Production Compose additionally requires: `POSTGRES_PASSWORD`,
`WAL_ARCHIVE_DIR`, `API_START_COMMAND` (reviewed API adapter command),
`WORKER_START_COMMAND`. The API/worker images **fail closed** without them.

## 4. Local development

```sh
npm install
cp .env.example .env
npm run validate:environment
docker compose up -d postgres
node scripts/dev-bootstrap.mjs --target development
npm run db:status
```

Run targets (from `HumanBingoApp/`):

| Command | Serves |
|---|---|
| `npm run dev` | Legacy API runtime + Vite (`:5173` → proxies `/api`, `/ws` to `:3000`) |
| `npm run dev:web` | Next.js dev (rewrites `/api/*` to `API_PROXY_TARGET`, direct `WS_URL`) |
| `npm run build:web && WEB_PORT=3012 npm run start:web` | Standalone Next.js production build |
| `npm run preview` | `vite preview` of existing browser build (`:4173`) |

Health checks: `curl -i http://127.0.0.1:3000/health`
(`{"status":"ok"}`), `curl -i http://127.0.0.1:3000/ready`.

Teardown (non-destructive, preserves named volume):

```sh
docker compose down
```

Destructive (deletes local data): `docker compose down -v` — disposable data only.

## 5. Production-like Compose packaging

`deploy/compose.yml` builds `web` (static client + security headers + SPA
fallback, `:8080`), `api`, `worker`, and `postgres:16-alpine`. Validate
without starting:

```sh
docker compose -f deploy/compose.yml config
```

This is a packaging/operations check (CI runs it on every push). It is not a
hosting provider — put it behind your own TLS/reverse proxy or use the CDK
AWS path below for a public HTTPS URL.

## 6. AWS CDK deployment (public HTTPS URL)

Deploys: VPC (public / private-with-egress / isolated DB subnets),
ECS Fargate cluster with Container Insights, ALB, CloudFront distribution,
RDS PostgreSQL 16 (`db.t4g.medium`, encrypted, 20 GiB → 100 GiB autoscale,
7-day backups), Secrets Manager secrets (RDS creds + session secret), log
groups, CloudWatch alarms.

### 6.1 Configure AWS

```sh
aws sts get-caller-identity
export AWS_REGION=<region>   # e.g. ap-southeast-1
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export CDK_DEFAULT_REGION=$AWS_REGION
```

Bootstrap once per account/region:

```sh
cd HumanBingoApp/infra
npx cdk bootstrap
```

### 6.2 Synth and diff

```sh
cd HumanBingoApp/infra
npm ci
npm run synth     # emits cdk.out (git-ignored, regenerable)
npm run diff      # review before deploy
```

### 6.3 Deploy

```sh
npm run deploy
```

Record the stack outputs:

| Output | Meaning |
|---|---|
| `AppUrl` | **The public HTTPS event URL** (CloudFront) — share this |
| `CloudFrontDomain` | Raw distribution domain |
| `DatabaseEndpoint` | Private RDS endpoint (not public) |
| `ApiDesiredTasks` | API task count (keep at 1, see §1) |

The API task runs idempotent initial/additive migrations before starting the
server entrypoint. RDS credentials and the session secret are generated in
Secrets Manager and injected — never in env files.

### 6.4 Update and tear down

```sh
npm run diff      # review
npm run deploy    # roll forward; rollback via previous image/migration plan
npx cdk destroy   # tears down all AWS resources (data loss on RDS)
```

Never run down-migrations or restore validation against production. Rollback
checks use a disposable database: `npm run migrate:rollback:check` with
`MIGRATION_ROLLBACK_DATABASE_URL` set.

## 7. Operations runbook

| Task | Command |
|---|---|
| Apply migrations | `npm run migrate` (via `psql`, checked-in ledger) |
| Migration status | `npm run db:status` (non-zero when pending/inconsistent) |
| Backup | `npm run backup` (`pg_dump` custom format; needs WAL archiving per `ops/backup.env.example`) |
| Verify backup | `npm run backup:verify` (archive index check) |
| Preview outbox republish | `npm run outbox:replay -- --dry-run --game-id <id>` |
| Republish events | omit `--dry-run` (clears retry markers for worker republish) |
| Full verification | `npm run test:all` (typecheck, lint, unit, property ≥100 cases, integration, browser, accessibility) |

Backup/PITR policy: managed PostgreSQL with WAL archiving; see
`ops/backup.env.example`, `ops/postgresql-pitr.conf.example`, `ops/nginx.conf`,
`ops/security-headers.conf`.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `server.js` missing / `dev` exits | `npm run build`; the lifecycle default is `node packages/api/dist/server.js` — supply `API_RUNTIME_COMMAND` if using another composition root |
| Env validation fails | `cp .env.example .env`, set `DATABASE_URL`, `PUBLIC_APP_ORIGIN`, 32+ char `SESSION_SECRET`; never paste secrets into issues |
| Postgres unavailable | `docker compose ps`, `docker compose logs postgres`, `npm run db:wait`; confirm port 5432 free and URL matches Compose mapping |
| Port clash (3000/5173/4173) | Stop owner or set `PORT` / `BROWSER_DEV_PORT` / `PREVIEW_PORT`; keep `API_PROXY_TARGET` aligned |
| Migration pending | `npm run db:wait`, `npm run db:status`, `npm run db:migrate` — never fix auth/role problems with `db:reset` |
| Browser tests won't launch | `npm run test:browser:check`, then `npm run test:browser:install` or system Chromium + `PLAYWRIGHT_EXECUTABLE_PATH` |
| CDK `synth` fails | `npm ci` in `infra/`; confirm `npx tsc --noEmit` passes; check `cdk.json` app entry `npx tsx bin/app.ts` |
| CDK `deploy` auth fails | `aws sts get-caller-identity`; set region/account; `npx cdk bootstrap` first |
| No `AppUrl` output | Stack didn't finish — check CloudFormation events in console; ALB/RDS take several minutes |

## 9. Security notes

- `.env` and any real credential must never be committed (root + `HumanBingoApp/.gitignore` enforce this; CI validates with placeholder secrets).
- Production requires HTTPS, non-localhost database, `DATABASE_SSL_MODE=verify-full`.
- Compose/API images run `read_only`, `cap_drop: [ALL]`, `no-new-privileges`.
- Fargate tasks accept traffic only from the ALB security group; RDS lives in isolated subnets.
