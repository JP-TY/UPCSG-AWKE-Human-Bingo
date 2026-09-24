# Human Bingo Bugfix Design

## Overview

This design addresses the runtime/local-development blockers recorded in `bugfix.md` without changing the Human Bingo game contracts. The implementation is deliberately narrow:

1. Make one transaction-local state-version transition authoritative for verification request, reject, and retry mutations. The returned mutation result, persisted game row, persisted grid version, and subsequent command version must all use that same value.
2. Add a development-only PostgreSQL role bootstrap seam that creates the configured local role `jpty` only when it is absent, using a separately configured local administrator connection. It must be idempotent, preserve existing data and roles, and fail closed for test, production-like, or non-loopback targets.
3. Make browser validation resolve a usable Chromium executable in a deterministic order, validate explicit overrides, detect Arch system Chromium, retain Playwright-managed Chromium support, and report an actionable remedy when no executable is usable.
4. Remediate only the in-scope lint/format findings and run a single-run checkpoint that distinguishes product failures from unavailable local prerequisites.

No production schema, production credentials, destructive reset path, game-domain rule, browser-test assertion, or existing API/WebSocket contract is changed by this bugfix.

## Glossary

- **Bug_Condition (C)**: An accepted verification mutation sequence in which the result's advertised version, persisted authoritative version, grid version, or next command's known version are inconsistent.
- **Property (P)**: For every accepted verification mutation, exactly one authoritative version increment is committed and every version-bearing output uses that increment.
- **Preservation**: Existing verification authorization/state-machine behavior, local database data and existing roles, Playwright-managed Chromium behavior, browser assertions, and already-clean source behavior remain unchanged.
- **F**: The current verification mutation implementation, including `VerificationCompletionService`, `commitMutation`, and the transaction-shaped `VerificationRepository`.
- **F'**: The fixed implementation using one transaction-local `nextStateVersion` value and the safe local validation helpers described here.
- **Authoritative state version**: `VerificationState.game.stateVersion`, persisted once for each accepted state-changing command.
- **Mutation result version**: `VerificationMutationResult.stateVersion`, the version the caller must use for its next state-dependent command.
- **Grid version**: The `GridRecord.stateVersion` written for grids affected by a game mutation.
- **Accepted mutation**: A request creation or confirm/reject action that passes validation, changes state, and commits successfully. Idempotent replay is not a new mutation.
- **Local role bootstrap**: A development setup operation that inspects `pg_roles` through an administrator connection and creates `jpty` only when the role is missing.
- **Usable Chromium executable**: A configured or discovered binary that exists, is executable, and can return a version or launch under the browser test harness.
- **Environment-blocked check**: A validation result caused by a missing external prerequisite, such as Docker, PostgreSQL, or Chromium, rather than by a product defect.

## Bug Details

### Bug Condition

The verification service has two separate sources of truth for the next version. `toResult` constructs a result using `state.game.stateVersion + 1n` before `commitMutation` advances the game and grid records. `commitMutation` then computes the next version again and persists it. These calculations happen inside the same in-memory callback today, so the targeted property can pass, but the contract is fragile: a persistence adapter, retry path, or future mutation branch that advances state before result construction can return a version derived from a stale pre-commit state. The generated request → reject → retry sequence is the smallest sequence that exposes the mismatch because it requires the retry to use the rejection's authoritative version.

The safe implementation must make version allocation a single operation. The mutation callback must allocate one `nextStateVersion`, apply it to the authoritative game and affected grids, construct all version-bearing result/event data from it, and commit that staged state. No caller or test model may infer an accepted version by counting commands that were attempted; rejected commands and idempotent replays do not increment it.

**Formal Specification:**

```text
FUNCTION isBugCondition(input)
  INPUT: input of type VerificationSequence
  OUTPUT: boolean

  state := input.initialState
  FOR command IN input.commands DO
    IF command is accepted and command is not an idempotent replay THEN
      result := F(command, state)
      persisted := state after F commits command
      IF result.stateVersion != persisted.game.stateVersion
         OR any affected persisted grid.stateVersion != result.stateVersion
         OR the next valid command's knownStateVersion is not result.stateVersion
      THEN
        RETURN true
      END IF
    END IF
  END FOR
  RETURN false
END FUNCTION
```

The bug condition includes these concrete cases:

- Starting from version `0`, a valid request for square `0` advertises or persists a version other than `1`.
- After that request, an identified participant rejects it, but the response result and persisted game disagree about version `2`.
- A later valid request for square `0` is submitted with `knownStateVersion = 2`; if the prior rejection exposed `2` but the authoritative state is `1`, or vice versa, the retry is rejected as stale or is evaluated against the wrong version instead of completing at version `3`.

### Examples

1. **Request → reject → retry:** Starting at version `0`, requester `ALPHA` submits a valid request for square `0`. The result and state must both be version `1`. `BRAVO` rejects with known version `1`; both result and state must be version `2`. `ALPHA` retries with known version `2`; the new pending request must be accepted and both result and state must be version `3`. The rejected request and notification remain history; the square is pending again with exactly one active request.
2. **Rejected command does not advance state:** Starting at version `0`, an invalid Player_Code request is rejected. The game, grid, square, request history, notification history, completion records, and version remain unchanged at version `0`. A following valid request with known version `0` must still succeed with version `1`.
3. **Idempotent replay does not advance state:** A request accepted at version `0` and committed at version `1` is submitted again with the same game, actor, and idempotency key. The original result is returned, no new request or notification is created, and the authoritative version remains `1`. The same rule applies to a confirm/reject replay.
4. **Concurrent state-dependent command:** Two commands start with known version `2`. Exactly one can commit version `3`; the other receives a stale-state response with the current version and makes no partial change. The successful result and persisted state must both identify version `3`.
5. **Transactional failure:** If persistence fails after request, square, notification, completion, or version staging begins, the transaction publishes none of those changes. The next valid command continues from the prior authoritative version.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**

- Verification membership, same-game Player_Code scoping, no self-verification, one pending request per square, identified-participant response authorization, closed-game rejection, and stale-state rejection remain enforced.
- A rejected request remains in history, leaves the square available for a later request, contributes to no completion, and resolves exactly its durable in-app notification.
- A valid request creates exactly one request and one pending in-app notification; confirm/reject changes the request, square, and notification atomically. Browser push remains best effort.
- Idempotent replays return the original accepted result without a second state-version increment or duplicate records.
- Failed validation, stale commands, authorization failures, and transaction failures leave request history, square status, notifications, completions, grids, and game version unchanged.
- Existing local PostgreSQL database rows, schemas, named volume, and already-present roles are not reset, dropped, renamed, or password-rotated by bootstrap.
- The existing development/test database target separation, migration ledger, bounded wait, explicit reset guard, and non-destructive Compose teardown remain unchanged.
- Playwright continues to use the existing base URL, web-server command, Chromium project, single-run semantics, and browser/accessibility assertions. Playwright-managed Chromium remains valid when installed.
- Existing clean TypeScript, lint, format, unit, property, integration, build, and documentation checks remain unchanged outside the files directly required by this bugfix.

**Scope:**

All inputs that do not satisfy `isBugCondition` must be unaffected. This includes invalid or unauthorized verification commands, idempotent replays, non-verification game actions, existing database data, non-local database targets, already-valid role configuration, Playwright-managed Chromium, valid explicit Chromium overrides, and browser tests unrelated to executable selection. No production-like environment may execute the role-changing bootstrap.

### Correct Behavior Specification

```text
FUNCTION expectedBehavior(input)
  INPUT: input of type VerificationSequence
  OUTPUT: VerificationOutcome

  stateVersion := input.initialState.game.stateVersion
  FOR command IN input.commands DO
    IF command is rejected before mutation THEN
      ASSERT authoritative state remains unchanged
      ASSERT no new version is returned
    ELSE IF command is an idempotent replay THEN
      ASSERT returned result equals the original accepted result
      ASSERT authoritative state remains unchanged
    ELSE
      nextVersion := stateVersion + 1
      ASSERT returned result.stateVersion == nextVersion
      ASSERT persisted game.stateVersion == nextVersion
      ASSERT every affected grid.stateVersion == nextVersion
      ASSERT the next state-dependent command may use knownStateVersion = nextVersion
      stateVersion := nextVersion
    END IF
  END FOR
END FUNCTION
```

## Hypothesized Root Cause

1. **Duplicated version calculation in verification mutations:** `toResult` predicts `state.game.stateVersion + 1n`, while `commitMutation` separately computes and applies the next version to the game and grids. The result is created before the authoritative mutation is finalized, so there is no single value that all result, persistence, and event code must share.
2. **Version-bearing records are not validated as one aggregate:** The service updates `game.stateVersion` and all grids in `commitMutation`, but the result path does not assert that the returned version equals the staged game and affected grid versions. A mismatch can therefore survive until a subsequent known-version command.
3. **Model sequences can obscure accepted-vs-rejected transitions:** The property model increments its expected version only after a successful command, but a regression test that derives versions from attempted commands or from stale result data can expect `3` while the authoritative state remains `2`. The regression must explicitly capture the result version and feed it into the next command.
4. **Operational role assumptions are implicit:** `dev-bootstrap.mjs` starts Compose and immediately calls `db:wait/create/migrate`; it has no preflight for a configured URL whose login role is `jpty`. `db:create` cannot recover when the URL’s role is absent because its maintenance connection is built from the same unavailable credentials.
5. **Chromium detection checks presence rather than usability:** `playwright.config.ts` uses `existsSync` for a short fixed candidate list and accepts any non-empty override without checking that it is executable or launchable. `test:browser:check` only asks Playwright for an install dry-run and does not identify a usable Arch system binary or give a targeted failure message.
6. **Validation checkpoints do not encode prerequisite classification:** The root scripts provide separate lint, format, database, browser, and test commands, but the reported checkpoint needs an explicit order and status vocabulary so a missing PostgreSQL/Chromium prerequisite is not confused with a source regression.

## Correctness Properties

Property 1: Bug Condition - One authoritative version for request/reject/retry

_For any_ verification sequence where accepted mutations occur, the fixed service SHALL increment the game state version exactly once per accepted non-replayed mutation, SHALL return that exact version, SHALL persist it on the game and affected grid records, and SHALL accept the next state-dependent command when it uses the returned version.

**Validates: Requirements 2.1, 2.3**

Property 2: Preservation - Rejected commands and idempotent replays are immutable

_For any_ verification input where the bug condition does not hold because the command is rejected before mutation or is an idempotent replay, the fixed service SHALL preserve the original authoritative records and version, return the original replay result when applicable, and SHALL not create a second request, notification, completion, or version increment.

**Validates: Requirements 2.2, 3.1, 3.2, 3.3**

Property 3: Local role bootstrap is safe and idempotent

_For any_ local development bootstrap run against a loopback PostgreSQL target, the bootstrap SHALL create `jpty` only when `pg_roles` has no such role, SHALL leave an existing role and database data unchanged, SHALL be repeatable, and SHALL reject production-like, test, or non-loopback targets before any role-changing SQL is executed.

**Validates: Requirements 2.4, 2.5, 2.9, 3.4, 3.5**

Property 4: Chromium resolution is deterministic and actionable

_For any_ browser validation environment with an explicit usable override, a usable Arch/system Chromium, an installed Playwright-managed Chromium, or no usable executable, the resolver SHALL select the first valid source in that order, SHALL preserve the existing Playwright project behavior, or SHALL report the exact installation/override remedy without an ambiguous launch error.

**Validates: Requirements 2.6, 2.7, 3.6**

Property 5: Lint/format remediation preserves behavior

_For any_ source file outside the reported lint/format findings, the remediation SHALL not alter behavior or public contracts, and the fixed repository SHALL produce clean single-run lint and format results with the existing typecheck and targeted regression checks still passing.

**Validates: Requirements 2.8, 3.7**

## Fix Implementation

### Changes Required

The following are implementation targets only; this design phase does not modify them.

#### 1. Verification version transition

**Files:** `packages/api/src/verification.ts`, `packages/api/src/verification.property.test.ts`, and the corresponding persistence transaction adapter if it materializes verification state.

**Specific changes:**

1. Replace the split `toResult`/`commitMutation` version calculation with a transaction-local helper such as `commitMutation(state, gameId, now, mutationPayload)` that first computes `nextStateVersion = state.game.stateVersion + 1n` exactly once.
2. Apply that value to `state.game.stateVersion`, `state.game.updatedAt`, and every affected `GridRecord.stateVersion` before constructing the result. Pass the value explicitly to result/event serialization rather than recomputing it from the old game state.
3. Construct the returned request, square, notification, completion, and `stateVersion` fields from the post-transition staged state. Keep the result’s public shape unchanged.
4. Keep idempotency lookup before version allocation. A replay returns the stored original result and does not call the commit helper. All validation failures occur before version allocation and therefore do not mutate state.
5. Add internal assertions in the transaction seam that returned version equals staged game version and each affected grid version. If the SQL adapter emits an outbox event, use the same next version for its unique `(game_id, state_version)` identity.
6. Preserve serializable/row-lock transaction behavior and retry only transaction serialization/deadlock failures. A retried transaction must recalculate from the newly loaded authoritative state and must not reuse a version from a failed attempt.
7. Extend the state-machine regression with a deterministic request → reject → retry example and assertions for result version, game version, grid version, request history, notification history, and the retry’s known version. Retain generated invalid, stale, unauthorized, duplicate-pending, and idempotent cases.

#### 2. Local-only PostgreSQL role bootstrap

**Files:** `scripts/dev-bootstrap.mjs`, a new narrowly scoped local role helper or equivalent database-command module, `.env.example`, and the relevant README/check tests during implementation.

**Specific changes:**

1. Run role preflight before `db:wait`, `db:create`, or `db:migrate`, only when `NODE_ENV=development` and the selected target is the explicitly local development target. Do not invoke it from test setup, production startup, `db:reset`, or generic migration paths.
2. Read the login role from the configured development `DATABASE_URL`; default documentation may identify `jpty`, but the helper must not silently change an explicitly configured production-like role. Require an explicit local administrator connection/credential for role creation, separate from the application URL, and redact it in all diagnostics.
3. Parse and validate both URLs before connecting. Require a loopback host (`localhost`, `127.0.0.1`, or `::1`), local development mode, and a PostgreSQL protocol. Reject `NODE_ENV=test`, `NODE_ENV=production`, `--target test`, non-loopback hosts, cloud/production SSL endpoints, and missing administrator credentials before any `CREATE ROLE` statement.
4. Connect to a maintenance database using the administrator URL and query `pg_roles` with a parameterized role name. If `jpty` is absent, create exactly one login role with the explicitly supplied local password and grant only the connection/schema prerequisites needed for the configured local development database. Do not use interpolated untrusted identifiers or shell command strings.
5. If `jpty` already exists, return success without altering its password, memberships, attributes, ownership, or grants. If it exists but cannot connect, report the missing local prerequisite and a manual remediation; do not silently alter it.
6. Never drop/recreate a role, database, schema, table, volume, or data. Preserve `docker compose down` as the non-destructive teardown and keep `db:reset` as the separately guarded explicit destructive operation.
7. Make concurrent/repeated bootstrap safe: serialize or tolerate the race where another local bootstrap creates the role between the existence check and `CREATE ROLE`, then re-check that the resulting role exists without modifying it. Continue with the existing bounded wait, idempotent database creation, and migration commands.
8. Add tests with a temporary/local PostgreSQL target for missing-role creation, existing-role no-op, repeated bootstrap, existing data preservation, production/non-loopback/test rejection, and redacted failure output. When PostgreSQL is unavailable, report the database tests as environment-blocked with the exact Docker/`psql` remedy rather than resetting another database.

#### 3. Arch Linux Chromium detection and override

**Files:** `playwright.config.ts`, a new synchronous browser-executable resolver/check helper, `package.json` browser-check command wiring, and README/check tests during implementation.

**Specific changes:**

1. Resolve in this order: a non-empty `PLAYWRIGHT_EXECUTABLE_PATH`, a usable system Chromium discovered from `PATH` and known candidates (including Arch’s `/usr/bin/chromium`), then an existing Playwright-managed Chromium executable. Do not force a system path when Playwright-managed Chromium is valid.
2. For an explicit override, require a regular file with execute permission and perform a safe `--version`/launchability check. On failure, terminate the browser check before the suite with a message naming the invalid path and the alternatives: `sudo pacman -S chromium`, `npm run test:browser:install`, or a corrected `PLAYWRIGHT_EXECUTABLE_PATH`.
3. For a system candidate, verify it is executable and usable rather than relying only on `existsSync`. Keep candidate discovery portable for non-Arch systems and avoid changing the browser project, base URL, web-server command, or test assertions.
4. Make `npm run test:browser:check` print the selected source/path and a machine-readable success or environment-blocked result. If no executable is available, fail with an actionable message that explicitly names the Arch installation command and override variable.
5. Keep `PLAYWRIGHT_EXECUTABLE_PATH` an explicit escape hatch for non-standard Arch installations and CI images. Do not send source code, credentials, or project data to an external service.
6. Add unit tests for override precedence, invalid override, `/usr/bin/chromium` selection, Playwright-managed fallback, and no-executable diagnostics. Add a single-run browser smoke check when a usable executable is available; otherwise classify only that check as environment-blocked.

#### 4. Lint/format remediation and checkpoint

**Files:** only source/configuration files identified by the lint and format reports, plus checkpoint/test documentation if needed.

**Specific changes:**

1. Capture baseline output from `npm run lint` and `npm run format`; classify each finding as an actual source issue, intentional ignored/generated content, or environment/tooling failure. Do not add broad `eslint-disable` comments, weaken rules, or format `.kiro` artifacts that are intentionally ignored.
2. Apply the smallest source-level fixes for affected TypeScript imports, promise handling, type safety, and formatting. Preserve exported contracts and runtime semantics. Use the pinned repository Prettier configuration rather than editor-specific formatting.
3. Validate in this order: `npm run typecheck`, `npm run lint`, `npm run format`, targeted verification property/unit tests, database command/bootstrap tests, Vite/build smoke checks, then browser/accessibility checks when Chromium is usable.
4. Add or use a checkpoint runner that reports `PASS`, `PRODUCT_FAILURE`, or `ENVIRONMENT_BLOCKED` per check. Product failures remain non-zero and require remediation. Environment-blocked checks name the missing prerequisite and exact command, while never silently claiming the product suite passed.
5. Keep all commands single-run; do not add watch processes or start a development server as part of the checkpoint. `npm run dev` remains a manual developer command.

## Testing Strategy

### Validation Approach

Validation uses three layers: first reproduce or guard the counterexample on the unfixed behavior, then verify the fixed behavior for the bug condition, then verify preservation for all non-buggy inputs. Operational checks are isolated from product checks so missing Docker/PostgreSQL/Chromium is visible as an environment prerequisite rather than masked as a code failure.

### Exploratory Bug Condition Checking

**Goal:** Confirm the version mismatch boundary before implementation and preserve a reproducible regression after implementation.

**Test Plan:** Use the existing in-memory verification repository and, when available, the PostgreSQL transaction adapter. Run a deterministic sequence with fixed timestamps and IDs:

1. Start an active game at version `0`.
2. Submit a valid request for square `0`; record the result and persisted game/grid versions.
3. Reject that request with the result version as `knownStateVersion`.
4. Submit a later valid request for square `0` using the rejection result version.
5. Compare each result version with persisted game version, affected grid version, and the known version used by the next accepted command.

**Expected Counterexamples on the unfixed implementation:** A result or grid may be derived from a different version than the authoritative game row, causing the retry to receive `STALE_STATE` or to expect version `3` while persistence remains at `2`. If the current checkout continues to pass this sequence, retain the test as a guard and record that the dual-calculation root risk is not reproduced by the current in-memory adapter.

Additional exploratory cases cover an invalid command, idempotent replay, concurrent commands with the same known version, and a forced transaction failure. Each must demonstrate no partial mutation.

### Fix Checking

**Goal:** Verify that every input satisfying the bug condition receives the correct one-step version transition.

**Pseudocode:**

```text
FOR ALL sequence WHERE isBugCondition(sequence) OR sequence exercises request/reject/retry DO
  outcome := F'(sequence)
  ASSERT expectedBehavior(outcome)
  ASSERT every accepted result version is strictly one greater than the prior authoritative version
  ASSERT every retry uses the immediately preceding accepted result version
END FOR
```

**Required checks:**

- Deterministic request/reject/retry reaches versions `1`, `2`, and `3`.
- Returned version, game version, affected grid version, and next command known version agree after every accepted mutation.
- Repeated accepted request/response commands with the same idempotency identity return the original result and do not increment again.
- Serialization/deadlock retry reloads the authoritative version and commits at most one new version.
- A failed transaction publishes no request, square, notification, completion, grid, game, or outbox/version changes.

### Preservation Checking

**Goal:** Prove that behavior outside the version mismatch remains unchanged.

**Pseudocode:**

```text
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT behavior(F, input) == behavior(F', input)
  ASSERT rejected commands make no persistent mutation
  ASSERT existing local data and non-local safety guards remain unchanged
END FOR
```

**Testing Approach:** Use property-based state-machine tests for verification and focused unit/integration tests for scripts and executable resolution. Compare state fingerprints before and after rejected commands. For local operations, use a disposable local test database only; never point a destructive test at the development or production-like URL.

### Unit Tests

- Verify one version allocator is used by request, confirm, reject, completion, grid-version, and result serialization paths.
- Verify result/state/grid versions for accepted request, reject, later retry, completion-producing confirm, idempotent replay, stale command, and rejected validation.
- Verify local role URL parsing, loopback/mode/target guards, parameterized role existence handling, existing-role no-op, redaction, and race-safe repeated invocation.
- Verify Chromium resolver precedence, executable permission/version checks, Arch candidate discovery, valid override, invalid override, Playwright-managed fallback, and actionable no-executable output.
- Verify lint/format checkpoint status mapping and that ignored/generated files are not used to hide source findings.

### Property-Based Tests

- **Verification fix property:** Generate valid request/reject/retry sequences interleaved with invalid, stale, duplicate-pending, unauthorized, and idempotent commands. Assert exact accepted-version progression, unchanged state on rejected commands, and next-command use of returned version. Run at least 100 cases with reproducible seed output.
- **Verification preservation property:** Generate non-buggy commands and compare the fixed state fingerprint with the original/reference model for request history, square statuses, notifications, completions, authorization errors, and versions.
- **Role bootstrap property:** Generate loopback URL/mode/role-existence combinations and assert create-only-when-missing, repeated no-op behavior, data preservation, and rejection before SQL for unsafe targets. Database-backed cases run only against an isolated local database.
- **Chromium resolution property:** Generate override/candidate availability and executability combinations and assert deterministic precedence and remediation classification without changing unrelated Playwright options.
- **Checkpoint property:** Generate check outcomes and prerequisite availability and assert product failures remain failures while missing external prerequisites are reported as environment-blocked with remediation.

### Integration Tests

- Run the verification request → reject → retry flow against the real persistence transaction boundary and assert game, grid, result, request history, notifications, completions, and any outbox event all carry the same accepted version.
- Run concurrent same-game commands and force a transaction serialization retry; assert one accepted increment per committed command and no duplicate version/event.
- Start local PostgreSQL through the existing pinned Compose service, create the missing `jpty` role through the admin path, run `db:wait/create/migrate`, rerun bootstrap, and verify a sentinel table/row and existing role attributes remain unchanged. Run explicit negative cases for test, production, and non-loopback URLs.
- Run the browser executable check on Arch with `/usr/bin/chromium`, with a non-standard `PLAYWRIGHT_EXECUTABLE_PATH`, with Playwright-managed Chromium, and with no executable. Verify exact remediation output before running browser tests.
- Run `npm run typecheck`, `npm run lint`, and `npm run format` in single-run mode, followed by targeted unit/property/integration checks. Run `npm run test:browser` and `npm run test:accessibility` only when the executable check is `PASS`; otherwise record `ENVIRONMENT_BLOCKED` and the installation/override command.
- Preserve the existing browser base URL, web-server workflow, accessibility assertions, database isolation, non-destructive Compose teardown, and production safety checks throughout the checkpoint.
