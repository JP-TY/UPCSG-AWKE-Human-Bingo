# Implementation Plan: Human Bingo Bugfix

## Overview

This plan implements only the blockers described in [`bugfix.md`](./bugfix.md) and the corresponding design in [`design.md`](./design.md). It does not implement new game features or alter public game contracts.

- **Verification:** one authoritative state-version allocation for accepted request/reject/retry mutations; rejected commands and idempotent replays remain immutable.
- **Local PostgreSQL:** development-only, loopback-only, idempotent creation of the configured local login role (documented default: `jpty`) through a separately configured administrator connection.
- **Chromium:** deterministic explicit-override, system/Arch, and Playwright-managed resolution with actionable single-run checks.
- **Lint/format:** smallest in-scope source/configuration remediation only.
- **Checkpoint:** ordered validation with `PASS`, `PRODUCT_FAILURE`, and `ENVIRONMENT_BLOCKED` classification.

### Required execution order

1. Explore the verification bug on unfixed behavior.
2. Observe and encode preservation behavior on unfixed behavior.
3. Implement the verification fix and rerun the same tests.
4. Implement the local database, Chromium, and lint/format remediation in the implementation phase.
5. Run the final checkpoint and classify unavailable external prerequisites without claiming those checks passed.

### Dependency graph

```text
1 Bug-condition exploration ─┐
                              ├─> 3 Verification fix and regression validation ─┐
2 Preservation properties ────┘                                                  │
4 Local role bootstrap  <-------------------------------------------------------┤
5 Chromium resolution      <----------------------------------------------------┤
6 Lint/format remediation  <----------------------------------------------------┘
                                      └─> 7 Final checkpoint and classification
```

Tasks 4–6 may be implemented independently after tasks 1–3 establish the test baseline, but task 7 depends on all implementation tasks and their targeted checks. The exploration and preservation tests are standalone tasks and must remain before implementation.

## Tasks

- [x] 1. Write the verification bug-condition exploration test before implementing the fix
  - **Property 1: Bug Condition** - One authoritative version across request, rejection, and retry
  - **IMPORTANT:** Write and run this test against the unfixed implementation before changing production code. The test is expected to fail when the dual-version calculation is observable; do not weaken the assertion to make the unfixed test pass.
  - Use the deterministic sequence from Design / Testing Strategy: start at game version `0`; requester `ALPHA` requests square `0`; identified participant `BRAVO` rejects using the returned version; requester retries square `0` using the rejection result's known version.
  - Encode `isBugCondition(input)` from design: for every accepted non-replayed mutation, compare the returned result version with the persisted game version and every affected grid version, then feed that returned version into the next valid command. Assert the sequence reaches versions `1`, `2`, and `3`, with the retry accepted at version `3`.
  - Assert request history, square status, durable notification history, and any completion/outbox/version-bearing records match the accepted mutation version. Rejected commands and idempotent replays must not be counted as accepted transitions.
  - Scope the regression to the concrete request → reject → retry case for reproducibility, then retain generated invalid, stale, unauthorized, duplicate-pending, and idempotent commands where the existing state-machine harness supports them.
  - Run at least 100 generated cases with a reproducible fast-check seed when the property harness is used. If the current in-memory adapter passes before the fix, record that the persistence-adapter mismatch is not reproduced while retaining the regression as a guard; do not delete the test or reinterpret a passing baseline as proof that the design risk is absent.
  - Candidate coverage: `packages/api/src/verification.property.test.ts`, plus a persistence integration test when the real transaction adapter is available.
  - Test command: `npx vitest run --config vitest.property.config.ts packages/api/src/verification.property.test.ts`.
  - **Expected unfixed outcome:** failure or a documented non-reproduction of the dual-calculation risk, with concrete counterexamples recorded if found.
  - _Bug_Condition: `isBugCondition(input)` from Design / Bug Condition._
  - _Expected_Behavior: `expectedBehavior(result)` requires one increment per accepted mutation, persisted game/grid/result agreement, and retry with the preceding returned version._
  - _Requirements: 1.1, 1.2, 2.1, 2.3_

- [x] 2. Write preservation property tests before implementing the fix
  - **Property 2: Preservation** - Rejected commands and idempotent replays are immutable
  - **IMPORTANT:** Follow observation-first methodology. Run the unfixed code with non-buggy inputs, record actual behavior, then encode those observations in property tests before modifying implementation code.
  - Cover invalid Player_Code, self-verification, cross-game access, stale known version, unauthorized response, duplicate pending request, closed-game rejection, failed persistence/transaction, and commands that are rejected before mutation. Compare a state fingerprint before and after each rejection for game, grids, squares, request history, notifications, completions, and version.
  - Cover an accepted request/response replay with the same idempotency identity. Assert the original result is returned, no second request or notification is added, and game/grid versions do not increment.
  - Preserve existing domain behavior: membership and same-game scoping, no self-verification, one active request per square, identified-participant response authorization, rejected-request history and notification resolution, completion behavior, and best-effort push semantics.
  - Ensure tests pass on unfixed code. If an observation differs from the design's stated preservation contract, document the observed behavior and stop for a requirements decision rather than silently changing the test.
  - Candidate coverage: existing `packages/api/src/verification.property.test.ts` and focused unit tests in the API package.
  - Test command: `npx vitest run --config vitest.property.config.ts packages/api/src/verification.property.test.ts`.
  - _Preservation: all inputs where `isBugCondition(input)` is false must preserve the original behavior and state fingerprint._
  - _Requirements: 2.2, 3.1, 3.2, 3.3_

- [x] 3. Fix authoritative verification version transitions and validate the regression
  - **Dependencies:** tasks 1 and 2 must be written and run first.
  - _Bug_Condition: accepted request/reject/retry sequences whose result, persisted game, affected grid, or next known version can diverge because `toResult` and `commitMutation` calculate the next version separately._
  - _Expected_Behavior: allocate one transaction-local `nextStateVersion`; apply it to the authoritative game and affected grids; construct result, request, square, notification, completion, and event data from the staged post-transition state; allow the next command to use that returned version._
  - _Preservation: validation failures, stale commands, unauthorized commands, idempotent replays, transaction failures, and existing verification authorization/state-machine rules remain unchanged and publish no partial mutation._
  - _Requirements: 1.1, 1.2, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.7_

  - [x] 3.1 Implement one transaction-local version allocator in the verification mutation seam
    - Update `packages/api/src/verification.ts` and the corresponding persistence transaction adapter only as needed.
    - Allocate `nextStateVersion = current authoritative version + 1` exactly once after replay lookup and all validation, then pass it explicitly to result/event serialization rather than recomputing it from pre-commit state.
    - Apply the same value to `VerificationState.game.stateVersion`, every affected `GridRecord.stateVersion`, and all version-bearing persistence/outbox data before the result is returned.
    - Keep idempotency lookup before allocation. Replays return the stored accepted result without a second increment; rejected commands allocate no version. A serialization/deadlock retry must reload state and allocate from the newly loaded version.
    - Add internal consistency assertions at the transaction seam for returned version = staged game version = each affected grid version. Preserve serializable/row-lock behavior and the existing public result shape.
    - Do not change membership, authorization, square, notification, completion, push, or error contracts.

  - [x] 3.2 Verify the bug-condition exploration test now passes
    - **Property 1: Expected Behavior** - One authoritative version across request, rejection, and retry
    - Re-run the exact test from task 1; do not create a replacement test.
    - Assert the deterministic sequence completes at versions `1`, `2`, and `3`, and that the retry's `knownStateVersion` is the immediately preceding accepted result version.
    - Assert affected grid versions, game version, result versions, request history, notification history, and completion/outbox records are consistent after each accepted mutation.
    - **Expected outcome:** `PASS`; if it fails, fix the implementation rather than changing the property.
    - _Requirements: 2.1, 2.3_

  - [x] 3.3 Verify preservation tests still pass
    - **Property 2: Preservation** - Rejected commands and idempotent replays are immutable
    - Re-run the exact tests from task 2; do not write new replacement tests.
    - Confirm rejected commands leave every fingerprinted record and version unchanged, while replays return the original result without duplicate records or increments.
    - **Expected outcome:** `PASS`.
    - _Requirements: 2.2, 3.1, 3.2, 3.3_

  - [x] 3.4 Add/retain transaction-boundary regression cases
    - Exercise completion-producing confirmation, same-known-version concurrency, serialization/deadlock retry, and forced persistence failure where the adapter supports fault injection.
    - Assert exactly one accepted increment per committed command and no request, square, notification, completion, grid, game, or outbox change after a failed transaction.
    - Test command: `npm run test:integration -- packages/api/src/verification.integration.test.ts` when the integration file exists; otherwise run the targeted property/unit suite and document the unavailable adapter.
    - _Requirements: 2.2, 2.3, 3.2, 3.3_

- [x] 4. Implement safe, idempotent local-only PostgreSQL role bootstrap and Arch guidance
  - **Dependencies:** task 3's verification baseline is complete; local database tests must use an isolated local target only.
  - _Bug_Condition: development bootstrap reaches `db:wait/create/migrate` with a missing configured `jpty` role, or retries without a safe documented role preflight._
  - _Expected_Behavior: in development and only for a loopback PostgreSQL target, inspect `pg_roles` through a separately configured local administrator connection, create the configured login role only when absent, then continue the existing bounded wait/create/migrate workflow._
  - _Preservation: existing roles, passwords, memberships, grants, database rows, named volumes, migration ledger, target separation, and non-destructive Compose teardown remain unchanged; production-like, test, cloud, and non-loopback targets are rejected before role-changing SQL._
  - _Requirements: 1.3, 1.4, 2.4, 2.5, 2.9, 3.4, 3.5_

  - [x] 4.1 Add the development-only role preflight seam
    - Update `scripts/dev-bootstrap.mjs`, add a narrowly scoped helper/module and tests as needed, and document variables in `.env.example`/README.
    - Parse the application `DATABASE_URL` and separate local administrator URL/credential before any connection. Require `NODE_ENV=development`, an explicitly local development target, PostgreSQL protocol, and loopback host (`localhost`, `127.0.0.1`, or `::1`). Reject `NODE_ENV=test`, `NODE_ENV=production`, `--target test`, non-loopback/cloud/production-like endpoints, missing admin credentials, and invalid URLs before `CREATE ROLE` can execute.
    - Query `pg_roles` with a parameterized role name. If the configured role (default documented as `jpty`) is missing, create exactly one login role with the explicitly supplied local password and only the documented connection/schema prerequisites. Never interpolate untrusted identifiers into shell commands or SQL.
    - If the role exists, return success without changing its password, attributes, memberships, ownership, grants, or data. Tolerate a create race by rechecking existence and never altering the concurrent creator's role.
    - Continue the current bounded `db:wait`, idempotent `db:create`, and `db:migrate` steps. Do not invoke the helper from production startup, test setup, generic migration paths, or destructive reset paths. Redact administrator/application URLs and passwords in all diagnostics.

  - [x] 4.2 Add isolated database tests and baseline observations
    - Test missing-role creation, existing-role no-op, repeated bootstrap, a sentinel row/data-preservation check, race-safe repeat, and rejection before role-changing SQL for test, production, non-loopback, cloud/SSL, and missing-admin cases.
    - Verify `db:reset` remains a separately guarded explicit destructive command and is not called by bootstrap. Verify `docker compose down` remains non-destructive and preserves the named PostgreSQL volume.
    - Preferred commands: `docker compose up -d postgres`; `npm run db:wait`; `npm run db:create`; `npm run db:migrate`; targeted database test command from the repository's integration configuration; then rerun `node scripts/dev-bootstrap.mjs`.
    - If Docker/PostgreSQL is unavailable, mark only these database-backed checks `ENVIRONMENT_BLOCKED` with the exact remedy (`docker compose up -d postgres`, then the commands above); do not point tests at another database or reset local data.
    - _Requirements: 1.3, 1.4, 2.4, 2.5, 2.9, 3.4, 3.5_

  - [x] 4.3 Document Arch/local PostgreSQL setup without destructive actions
    - Document the pinned Compose path as the preferred local workflow and, for native Arch PostgreSQL users, the required package/service/administrator prerequisites (including `sudo pacman -S postgresql` where native PostgreSQL is intentionally used), loopback-only URLs, and the separate local admin connection.
    - State that role bootstrap preserves existing data and roles; do not document `DROP ROLE`, schema reset, volume removal, or production credentials as a recovery step. Keep destructive reset instructions separate and explicitly guarded.
    - _Requirements: 2.4, 2.5, 2.9, 3.4, 3.5_

- [x] 5. Implement deterministic Arch/system/Playwright Chromium resolution and browser checks
  - **Dependencies:** task 3's test baseline is complete; browser suites run only after the executable check reports `PASS`.
  - _Bug_Condition: browser validation cannot launch a usable Chromium or cannot consistently select a system executable/override on Arch Linux._
  - _Expected_Behavior: resolve in deterministic order—usable non-empty `PLAYWRIGHT_EXECUTABLE_PATH`, usable system Chromium from PATH/known candidates including `/usr/bin/chromium`, then usable Playwright-managed Chromium—or fail with an actionable installation/override message._
  - _Preservation: existing Playwright base URL, web-server command, Chromium project, single-run semantics, browser assertions, and Playwright-managed Chromium behavior remain unchanged when managed Chromium is valid._
  - _Requirements: 1.5, 2.6, 2.7, 2.9, 3.6_

  - [x] 5.1 Add the executable resolver and validation seam
    - Update `playwright.config.ts`, add a synchronous resolver/check helper and focused tests, and change only the required `package.json` browser-check wiring.
    - Validate an explicit override as a regular executable file and perform a safe version/launchability check. An invalid override must fail early and name the path plus `sudo pacman -S chromium`, `npm run test:browser:install`, and corrected `PLAYWRIGHT_EXECUTABLE_PATH` remedies.
    - Discover portable PATH candidates and known system candidates (`/usr/bin/chromium`, `/usr/bin/chromium-browser`, `/usr/bin/google-chrome` as applicable), checking executable permission and usability rather than existence alone. Preserve Playwright-managed fallback and avoid forcing a system path when managed Chromium is usable.
    - Do not send source code, credentials, or project data to external services. Do not alter browser assertions or the existing web server/base URL.

  - [x] 5.2 Add resolver, browser-check, and accessibility coverage
    - **Property 3: Chromium Resolution** - Deterministic source precedence and actionable diagnostics
    - Cover valid override precedence, invalid override, usable `/usr/bin/chromium`, PATH discovery, Playwright-managed fallback, and no-executable output. Assert selected source/path and machine-readable `PASS` or `ENVIRONMENT_BLOCKED` classification.
    - Run the check in single-run mode. When it reports `PASS`, run `npm run test:browser -- --project=chromium` and `npm run test:accessibility`; when no executable is available, classify those suites as `ENVIRONMENT_BLOCKED` and do not report them as passed.
    - On Arch, the documented installation remedy is `sudo pacman -S chromium`; the non-standard executable escape hatch is `PLAYWRIGHT_EXECUTABLE_PATH=/absolute/path/to/chromium`; managed fallback is `npm run test:browser:install`.
    - _Requirements: 1.5, 2.6, 2.7, 2.9, 3.6_

- [x] 6. Remediate only scoped lint/format findings
  - **Dependencies:** tasks 1–5 establish the affected source and test changes; run a baseline before editing.
  - _Bug_Condition: the in-scope runtime/local-development checkpoint remains red because affected source/configuration has lint findings or formatting drift._
  - _Expected_Behavior: affected source/configuration produces clean single-run lint and format results while preserving runtime semantics, exported contracts, and all targeted regressions._
  - _Preservation: files outside reported findings, ignored/generated `.kiro` artifacts, game-domain behavior, and existing rule strength remain unchanged._
  - _Requirements: 1.6, 2.8, 3.7_

  - [x] 6.1 Capture and classify the baseline
    - Run `npm run lint` and `npm run format` once. Classify every finding as source issue, intentional ignored/generated content, or environment/tooling failure before editing.
    - Do not add broad `eslint-disable` comments, weaken rules, reformat `.kiro` artifacts solely to hide findings, or change generated output.
    - _Requirements: 1.6, 2.8_

  - [x] 6.2 Apply minimal remediation and validate affected scope
    - Change only files identified by the baseline or required by tasks 3–5. Preserve TypeScript public contracts and runtime behavior while fixing imports, promise handling, type safety, and pinned-Prettier formatting as applicable.
    - Run `npm run typecheck`, `npm run lint`, and `npm run format`; rerun the verification property/unit checks and affected script/resolver tests. Record any external-tool prerequisite as `ENVIRONMENT_BLOCKED`, not as a product pass.
    - _Requirements: 2.8, 3.7_

- [x] 7. Final checkpoint — validate all bugfix scope and classify prerequisites
  - **Dependencies:** tasks 3, 4, 5, and 6 are complete; all targeted tests must be rerun after the final source change.
  - Run single-run checks in this order:
    1. `npm run typecheck`
    2. `npm run lint`
    3. `npm run format`
    4. `npm run test:unit`
    5. `npm run test:property`
    6. `npm run test:integration` (including isolated PostgreSQL checks when available)
    7. `npm run build`
    8. local database bootstrap/status checks (`docker compose up -d postgres`, `npm run db:wait`, `npm run db:create`, `npm run db:migrate`, and repeat `node scripts/dev-bootstrap.mjs` only against the configured loopback development target)
    9. `npm run test:browser:check`
    10. `npm run test:browser` and `npm run test:accessibility` only if the Chromium check reports `PASS`.
  - Report each check as exactly one of:
    - `PASS`: command completed successfully and assertions ran.
    - `PRODUCT_FAILURE`: command ran and exposed a source, test, contract, or behavior failure; keep the checkpoint non-zero and fix it before completion.
    - `ENVIRONMENT_BLOCKED`: a required external prerequisite is unavailable; name the missing prerequisite and exact remedy, and do not claim the dependent product suite passed.
  - Verify the final acceptance set: request/reject/retry reaches versions `1/2/3`; rejected commands and replays are immutable; local role creation is missing-only/idempotent and loopback-guarded; Chromium selection/check diagnostics are deterministic; lint/format are clean; no production-like target or persistent local data was destructively modified.
  - Do not run `db:reset`, schema drops, volume removal, role drops/recreation, production migrations, or destructive teardown as part of this checkpoint. `npm run dev` remains a manual long-running developer command and must not be started by the checkpoint.
  - _Requirements: 2.1-2.9, 3.1-3.7_

## Notes

The task artifact is complete only when implementation notes or linked test output record:

- the unfixed exploration result and any concrete counterexamples (or explicit non-reproduction in the current adapter);
- preservation properties passing before and after the fix;
- the fixed request/reject/retry and transaction-boundary checks passing;
- local role bootstrap tests, including no-op/repeat/data-preservation/safety cases, or an explicit `ENVIRONMENT_BLOCKED` report with remediation;
- Chromium resolver/check tests and browser/accessibility results, or an explicit `ENVIRONMENT_BLOCKED` report with Arch/Playwright remediation;
- clean typecheck, lint, format, and build output; and
- no destructive production or local-data action introduced by the implementation.
