# Deployment artifacts

These files are packaging and operational checks only; they do not deploy anything.

- `docker compose -f deploy/compose.yml config` validates the manifest without starting services.
- `containers/web.Dockerfile` builds the static browser client and serves it with security headers and SPA fallback.
- `containers/api.Dockerfile` and `containers/worker.Dockerfile` build the API/worker package artifacts. They intentionally fail closed unless a reviewed runtime adapter is supplied with `API_START_COMMAND` or `WORKER_START_COMMAND`; the repository currently exposes framework-neutral application services rather than a production server composition.
- `npm run migrate` runs the checked-in PostgreSQL migration through `psql`; `npm run migrate:rollback:check` runs up/down against `MIGRATION_ROLLBACK_DATABASE_URL` outside production.
- `npm run backup` creates a custom-format `pg_dump`; `npm run backup:verify` validates its archive index. Configure PostgreSQL WAL archiving separately using `ops/backup.env.example` and a managed PostgreSQL/PITR policy.
- `npm run outbox:replay -- --dry-run --game-id <id>` previews events; omit `--dry-run` to clear retry markers for the selected events so the worker can republish them. Identifiers are restricted to safe SQL identifier characters.

Use a disposable database for rollback and restore checks. Never run the down migration or restore validation against production.
