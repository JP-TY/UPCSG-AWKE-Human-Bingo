# Human Bingo

Human Bingo is a TypeScript workspace containing the browser client, API/domain packages, PostgreSQL persistence, worker utilities, and automated tests.

## Prerequisites

- Node.js compatible with the repository toolchain (Node 20+ recommended).
- npm (the repository includes `package-lock.json`; use `npm install` from the repository root).
- Docker Engine and Docker Compose for the local PostgreSQL service.
- PostgreSQL client tools (`psql` and `pg_isready`) on `PATH` for database commands and integration tests.
- Chromium for browser tests. Run `npm run test:browser:install` when a usable system Chromium is not already installed.

All commands below run from the repository root. Do not commit `.env` or real credentials.

## Environment setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create the local environment file and edit the development secret if needed:

   ```sh
   cp .env.example .env
   ```

   The checked-in example uses these local defaults:

   | Variable                  | Local default                                    | Purpose                                                   |
   | ------------------------- | ------------------------------------------------ | --------------------------------------------------------- |
   | `NODE_ENV`                | `development`                                    | Runtime mode                                              |
   | `HOST`                    | `127.0.0.1`                                      | API bind host                                             |
   | `PORT`                    | `3000`                                           | API port                                                  |
   | `BROWSER_DEV_PORT`        | `5173`                                           | Vite development port                                     |
   | `PREVIEW_PORT`            | `4173`                                           | Vite preview port                                         |
   | `API_PATH` / `WS_PATH`    | `/api` / `/ws`                                   | HTTP and WebSocket paths                                  |
   | `DATABASE_URL`            | `postgres://jpty:...@localhost:5432/human_bingo` | Development application database                          |
   | `DATABASE_ADMIN_URL`      | `postgres://postgres@localhost:5432/postgres`    | Separate loopback admin URL used only by role preflight   |
   | `DATABASE_ADMIN_PASSWORD` | placeholder                                      | Local admin credential; never use a production credential |
   | `DATABASE_ROLE`           | `jpty`                                           | Login role created only when absent                       |
   | `DATABASE_ROLE_PASSWORD`  | placeholder                                      | Password for a newly created local role                   |
   | `TEST_DATABASE_URL`       | `postgres://localhost:5432/human_bingo_test`     | Isolated test database                                    |
   | `SESSION_SECRET`          | placeholder                                      | At least 32 characters                                    |
   | `PUBLIC_APP_ORIGIN`       | `http://localhost:4173`                          | Public browser origin                                     |

   `DATABASE_ADMIN_URL`, `DATABASE_ADMIN_PASSWORD`, and `DATABASE_ROLE_PASSWORD` are required only for the development role preflight. The administrator URL must be a separate loopback PostgreSQL URL without an embedded password; the role password is used only when the configured application role is missing. Keep the application URL and role password aligned. The preflight refuses test, production, SSL, cloud, and non-loopback targets before any role-changing SQL.

   Run the development bootstrap with an explicit local target:

   ```sh
   node scripts/dev-bootstrap.mjs --target development
   ```

   It starts the pinned local PostgreSQL service, creates the configured login role only when absent, and then runs the existing bounded wait, idempotent database creation, and migration steps. An existing role and all local data are left unchanged.

   `PORT` is the API runtime setting. The legacy `API_PORT` is accepted by the typed API configuration as a fallback, but prefer `PORT`.

3. Validate the environment before starting services:

   ```sh
   npm run validate:environment
   ```

   Validation reports variable names and reasons, not secret values. Production additionally requires HTTPS, non-localhost database configuration, `DATABASE_SSL_MODE=verify-full`, and backup paths.

## Local PostgreSQL setup

### Preferred: pinned Compose service

Use the repository's pinned Compose service for normal local development. It runs PostgreSQL `16.6-alpine`, binds the database port to loopback (`127.0.0.1:5432` by default), and stores data in the named `human-bingo-postgres-data` volume. Start it and run the safe development bootstrap:

```sh
docker compose up -d postgres
node scripts/dev-bootstrap.mjs --target development
```

The bootstrap validates the development target before connecting, waits for PostgreSQL, and creates the configured application login role only when that role is missing. It is repeatable: an existing role is left unchanged, and existing database rows, schemas, grants, memberships, and the named volume are preserved. `DATABASE_ADMIN_URL` is a separate local administrator connection used only for this preflight; it must not be the same login as `DATABASE_URL` and must not contain an embedded password.

Keep application and administrator connections on loopback. A typical local configuration is:

```dotenv
DATABASE_URL=postgres://jpty:replace-with-local-role-password@127.0.0.1:5432/human_bingo
DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres
DATABASE_ADMIN_PASSWORD=replace-with-local-admin-password
DATABASE_ROLE=jpty
DATABASE_ROLE_PASSWORD=replace-with-local-role-password
DATABASE_SSL_MODE=disable
HOST=127.0.0.1
PUBLIC_APP_ORIGIN=http://127.0.0.1:4173
```

The administrator URL intentionally names the maintenance database and the separate administrator login. Do not put its password in the URL, and do not use production credentials in local files. `DATABASE_ROLE` must match the login in `DATABASE_URL`; `DATABASE_ROLE_PASSWORD` is used only if that role is absent. The preflight rejects test, production, SSL, cloud, and non-loopback targets before role-changing SQL.

### Alternative: native Arch Linux PostgreSQL

Use this path only when PostgreSQL is intentionally managed by the Arch host rather than Compose. Install the native server and client tools, initialize a cluster only when `/var/lib/postgres/data` is new or empty, and start the service:

```sh
sudo pacman -S postgresql
if [ ! -f /var/lib/postgres/data/PG_VERSION ]; then
  sudo -iu postgres initdb -D /var/lib/postgres/data
fi
sudo systemctl enable --now postgresql.service
pg_isready --host=127.0.0.1 --port=5432
```

Do not rerun `initdb` over an existing cluster. Before bootstrap, the native service must be accepting loopback connections and the local administrator must be able to authenticate through `DATABASE_ADMIN_URL`. If the native installation uses peer-only authentication, configure an appropriate loopback password-authentication rule according to the host's local PostgreSQL policy, then set a local password for the administrator through a local administrative session (for example, `sudo -iu postgres psql` and `\password postgres`). Keep that administrator connection separate from the application connection shown above.

After the service and administrator prerequisites are ready, use the same loopback-only `.env` values and run:

```sh
node scripts/dev-bootstrap.mjs --target development
```

Role bootstrap is missing-only and idempotent for native PostgreSQL too: it creates `DATABASE_ROLE` once when absent, never drops or recreates an existing role, and does not reset or remove data. If the role or administrator cannot authenticate, fix the local service/authentication configuration or credentials; do not use a role drop, schema reset, volume removal, or production credential as recovery.

## First run

Use this order on a clean checkout:

```sh
npm install
cp .env.example .env
npm run validate:environment
docker compose up -d postgres
npm run db:wait
npm run db:create
npm run db:migrate
npm run db:status
npm run build
```

The Compose service is PostgreSQL `16.6-alpine`, bound to `127.0.0.1:5432`, with database `human_bingo`, user `human_bingo`, and the local password from Compose defaults or your environment. The container health check uses `pg_isready`.

### Start development

The intended development command starts the API runtime and Vite together:

```sh
npm run dev
```

Vite serves the browser at `http://127.0.0.1:5173` and proxies `/api` and `/ws` to the API at `http://127.0.0.1:3000`. Press `Ctrl-C` to stop both child processes.

The lifecycle runner's default API command is `node packages/api/dist/server.js`. This checkout currently builds the API package modules but does not contain `packages/api/src/server.ts` or a generated `packages/api/dist/server.js`; therefore `npm run dev`/`npm run start` will not become fully operational until that runtime entrypoint is supplied (or `API_RUNTIME_COMMAND` is set to an equivalent composition-root command). The runtime implementation and health/readiness behavior are in `packages/api/src/runtime.ts`.

## Root scripts

| Command                          | Behavior                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `npm run build`                  | TypeScript project build for all referenced packages.                                         |
| `npm run typecheck`              | TypeScript build/type check without pretty output.                                            |
| `npm run lint`                   | ESLint with warnings treated as failures.                                                     |
| `npm run format`                 | Check formatting with Prettier.                                                               |
| `npm run format:write`           | Rewrite supported files with Prettier.                                                        |
| `npm test` / `npm run test:unit` | Single-run Vitest unit tests with coverage.                                                   |
| `npm run test:property`          | Single-run fast-check/property tests with coverage; defaults to at least 100 cases.           |
| `npm run test:integration`       | Single-run integration tests; provisions the isolated test database.                          |
| `npm run test:browser`           | Single-run Playwright Chromium tests.                                                         |
| `npm run test:accessibility`     | Playwright accessibility/responsive suite.                                                    |
| `npm run test:all`               | Typecheck, lint, unit, property, integration, browser, and accessibility checks.              |
| `npm run check`                  | Typecheck, lint, and unit tests.                                                              |
| `npm run dev`                    | Supervise the API runtime and Vite development server.                                        |
| `npm run start`                  | Supervise only the API runtime.                                                               |
| `npm run preview`                | Run `vite preview` for an existing production browser build; it does not mutate the database. |
| `npm run validate:environment`   | Validate required environment values and formats.                                             |

Before browser tests, install Chromium if necessary:

```sh
npm run test:browser:install
```

## Database commands

Start PostgreSQL before all database commands:

```sh
docker compose up -d postgres
npm run db:wait
```

The root database commands target the development database by default and support `--target test` after the script name:

```sh
npm run db:wait
npm run db:create
npm run db:migrate
npm run db:status
npm run db:reset
```

Examples for the isolated test database:

```sh
npm run db:create -- --target test
npm run db:migrate -- --target test
npm run db:status -- --target test
```

- `db:wait` polls until PostgreSQL accepts connections. Set `DB_WAIT_TIMEOUT_MS` (minimum 1000 ms) to change its bounded timeout.
- `db:create` is idempotent and creates only the selected target database if needed.
- `db:migrate` applies the current migration ledger (`001_initial_schema`).
- `db:status` reports applied and pending migrations; it exits non-zero when pending or inconsistent.
- `db:reset` drops and recreates the **development `public` schema**, then reapplies migrations. It is refused unless `NODE_ENV=development`, target is `development`, and the database host is local. Existing development data is deleted.

Database command failures redact PostgreSQL URLs and passwords. They do not silently select the test database. Never run `db:reset` against a production-like database.

## Isolated integration tests

Integration setup requires an explicitly configured `TEST_DATABASE_URL` distinct from `DATABASE_URL` and runs with `NODE_ENV=test`. It creates/migrates the test database, drops and recreates only its `public` schema, then reapplies migrations. Development data is not reset or cleaned.

Run the isolated suite with:

```sh
NODE_ENV=test TEST_DATABASE_URL=postgres://localhost:5432/human_bingo_test npm run test:integration
```

The test setup also reads an existing `.env` without overriding explicitly supplied shell variables. To skip database-backed integration setup for a non-database run, use the relevant unit/property command instead; do not point `TEST_DATABASE_URL` at the development URL.

Property tests use `FAST_CHECK_NUM_RUNS` and `FAST_CHECK_SEED`; the shared defaults enforce at least 100 runs:

```sh
FAST_CHECK_NUM_RUNS=100 FAST_CHECK_SEED=20250308 npm run test:property
```

## Local URLs and checks

| Service                 | URL                             | Notes                                                                                                                           |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Vite development client | `http://127.0.0.1:5173`         | `npm run dev`; configurable with `BROWSER_DEV_PORT`.                                                                            |
| Vite production preview | `http://127.0.0.1:4173`         | Run `npm run build` first, then `npm run preview`.                                                                              |
| API liveness            | `http://127.0.0.1:3000/health`  | Returns HTTP 200 and `{"status":"ok"}` while the listener is live.                                                              |
| API readiness           | `http://127.0.0.1:3000/ready`   | Returns HTTP 200 and `{"status":"ready"}` when runtime/dependencies are ready; otherwise HTTP 503 and `{"status":"not_ready"}`. |
| API routes              | `http://127.0.0.1:3000/api/...` | Existing HTTP API contract.                                                                                                     |
| WebSocket gateway       | `ws://127.0.0.1:3000/ws`        | Vite proxies `/ws` in development.                                                                                              |

Check the endpoints with curl:

```sh
curl -i http://127.0.0.1:3000/health
curl -i http://127.0.0.1:3000/ready
```

A healthy liveness response does not guarantee readiness. During shutdown, health remains the liveness contract while readiness becomes non-ready and application requests are rejected.

## Troubleshooting

### Startup fails immediately or `server.js` is missing

Run `npm run build` and inspect `packages/api/dist`. The lifecycle defaults are controlled by `API_RUNTIME_COMMAND` and `BROWSER_DEV_COMMAND`. This repository currently has no API `server.ts` composition-root entrypoint, so the default API command cannot start until that entrypoint is added or `API_RUNTIME_COMMAND` is overridden with a valid command that constructs and starts the API runtime.

### Environment validation fails

Run:

```sh
npm run validate:environment
```

Copy `.env.example` to `.env`, set `DATABASE_URL`, `PUBLIC_APP_ORIGIN`, and a `SESSION_SECRET` of at least 32 characters. Check port values and PostgreSQL URL syntax. Do not paste secrets into issue reports.

### PostgreSQL is unavailable

Check container state and logs, then wait again:

```sh
docker compose ps

docker compose logs postgres
npm run db:wait
```

Confirm `psql` and `pg_isready` are installed, port 5432 is free, and `DATABASE_URL` matches the Compose mapping. If another PostgreSQL owns the port, stop it or set `POSTGRES_PORT` and update both database URLs.

### Port 3000, 5173, or 4173 is occupied

Find and stop the process owning the port, or set `PORT`, `BROWSER_DEV_PORT`, or `PREVIEW_PORT` in `.env`. Keep `API_PROXY_TARGET` aligned with the API host/port when using a non-default API port.

### Migration fails or status is pending

Run `npm run db:wait`, then `npm run db:status` and `npm run db:migrate`. Read the redacted command error. Do not use the destructive reset command to repair a missing role, authentication, or bootstrap problem. A development-schema reset is a separate, explicitly guarded operation for intentionally disposable local data only; it deletes existing development data.

### Tests try to touch development data

Verify `NODE_ENV=test` and that `TEST_DATABASE_URL` names a different database from `DATABASE_URL`:

```sh
npm run db:status -- --target test
```

The integration global setup refuses equal URLs before test modules run. Use unit/property tests when PostgreSQL is not available.

### Browser tests cannot launch

Run `npm run test:browser:check`, then `npm run test:browser:install`. A system Chromium at `/usr/bin/chromium`, `/usr/bin/chromium-browser`, or `/usr/bin/google-chrome` is also detected automatically. Set `PLAYWRIGHT_EXECUTABLE_PATH` for a different binary.

### Stale containers or unexpected database state

Inspect the service and named volume:

```sh
docker compose ps
docker volume ls | grep human-bingo-postgres-data
```

Restart without deleting data using `docker compose down` followed by `docker compose up -d postgres`. Use `db:status` and `db:migrate` to reconcile migrations.

## Teardown

Non-destructive teardown stops and removes the local container and network but preserves the named PostgreSQL volume and its data:

```sh
docker compose down
```

Do not use teardown or volume removal as role-bootstrap recovery. The destructive operation below is separate and explicitly guarded; it is only for disposable local data.

Destructive teardown additionally removes the named volume. It permanently deletes local database data, including development and test databases stored in that volume:

```sh
docker compose down -v
```

Only use `down -v` when the local data is disposable or you have a backup. The repository's backup helpers are available as `npm run backup` and `npm run backup:verify`; they require their configured PostgreSQL and backup paths.
