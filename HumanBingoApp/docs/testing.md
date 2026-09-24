# Testing

The repository keeps unit, property, integration, and browser checks as separate single-run commands:

```sh
npm ci
npm run typecheck
npm run lint
npm run test:unit
npm run test:property
npm run test:integration
npm run test:browser
```

Property tests use at least 100 cases by default and a stable seed. Override them when investigating a failure, while retaining the minimum case count:

```sh
FAST_CHECK_NUM_RUNS=250 FAST_CHECK_SEED=12345 npm run test:property
```

## Database tests

Database tests are opt-in and must use a dedicated PostgreSQL database. Set `NODE_ENV=test` and `TEST_DATABASE_URL`; never point this variable at a development or production database. `TEST_DATABASE_SCHEMA`, `TEST_DATABASE_RESET`, and `TEST_DATABASE_MAX_CONNECTIONS` control the isolated schema, reset behavior, and pool size. Tests can call `requireDatabaseTestConfig()` from `@human-bingo/test-utils` to fail closed when configuration is missing.

```sh
NODE_ENV=test \
TEST_DATABASE_URL=postgresql://localhost:5432/human_bingo_test \
npm run test:integration
```

The integration command itself does not require a running database until a database-backed test opts in through the helper, so pure integration tests remain runnable in a fresh checkout.

## Playwright on Linux

The browser command uses Playwright Chromium when it is installed. Install the pinned Playwright browser with the package script:

```sh
npm run test:browser:install
npm run test:browser
```

On Arch Linux, install the distribution Chromium package with the system package manager rather than using Playwright's Ubuntu-oriented `--with-deps` option:

```sh
sudo pacman -S chromium
npm run test:browser
```

The Playwright configuration automatically checks `/usr/bin/chromium`, `/usr/bin/chromium-browser`, and `/usr/bin/google-chrome`. For a non-standard location, set an explicit executable path:

```sh
PLAYWRIGHT_EXECUTABLE_PATH="$(command -v chromium)" npm run test:browser
```

`npm run test:browser:check` prints the Playwright-managed browser download plan without downloading anything. If neither a Playwright browser nor a system Chromium executable is available, the browser suite cannot launch; the exact remedy is either `npm run test:browser:install` or installing Arch's `chromium` package and setting `PLAYWRIGHT_EXECUTABLE_PATH`.

## Local PostgreSQL Compose lifecycle

Start the pinned local database with `docker compose up -d postgres`. Application migrations remain explicit; run `npm run db:wait` followed by `npm run db:migrate` rather than hiding migrations in container startup.

The non-destructive teardown command is:

```sh
docker compose down
```

It stops and removes the local PostgreSQL container and Compose network while preserving the named `human-bingo-postgres-data` volume.

**DESTRUCTIVE: deletes local database data.** Remove the named volume only when intentionally resetting local state:

```sh
docker compose down -v
```
