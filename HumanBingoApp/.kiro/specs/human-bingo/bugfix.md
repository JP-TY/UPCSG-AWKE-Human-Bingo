# Bugfix Requirements Document

## Introduction

This bugfix removes the blockers reported by the Human Bingo runtime/local-development checkpoint without changing the game's existing contracts. The bug condition C(X) includes an accepted verification request/rejection/retry sequence whose authoritative state versions diverge, a local development bootstrap that cannot proceed when the configured PostgreSQL role `jpty` is absent, an Arch Linux browser-validation environment that cannot reliably use an available system Chromium, or an in-scope lint/format checkpoint that cannot reach a clean single-run result. The desired property P(result) is that each accepted mutation has one authoritative version transition, local development is safely bootstrappable, browser validation can use a supported Chromium executable, and the declared validation commands pass or report an actionable environment prerequisite. Non-buggy behavior must remain unchanged.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a valid verification request for square 0 is accepted, its pending request is rejected, and a later valid request is submitted for the same square THEN the verification state-machine run can use a state version that does not match the authoritative state, causing the counterexample `valid request(square=0) -> reject pending request -> later retry after rejection` to expect version 3 while receiving version 2 and preventing the retry from completing.

1.2 WHEN an accepted verification mutation, a rejected command, or an idempotent replay is processed THEN the checkpoint does not reliably demonstrate that the persisted game state version, returned mutation version, and next command's known version remain consistent, so a version mismatch can be exposed only by the generated retry sequence.

1.3 WHEN local PostgreSQL is running or configured for development but the required local role `jpty` does not exist THEN the local bootstrap path fails before the database workflow can complete instead of preparing the missing local role idempotently.

1.4 WHEN the local bootstrap is retried after a partial or successful attempt THEN the current workflow does not provide a documented, repeatable guarantee that an existing `jpty` role is left unchanged and that the bootstrap succeeds without destructive database operations.

1.5 WHEN browser or accessibility validation runs on Arch Linux without Playwright-managed Chromium or headless tooling, while a system Chromium can be installed or exists at a non-default location THEN the workflow can fail to launch or cannot consistently select the system executable, and the recovery path is not expressed as an actionable Arch installation and `PLAYWRIGHT_EXECUTABLE_PATH` procedure.

1.6 WHEN the runtime/local-development checkpoint runs the repository lint and format checks THEN remaining in-scope findings or formatting drift can keep the checkpoint red, without a requirements-level clean-result and regression-validation contract for the affected scope.

### Expected Behavior (Correct)

2.1 WHEN a valid verification request, its rejection, and a later valid retry are accepted in sequence THEN the Human_Bingo_System SHALL commit exactly one authoritative state-version increment for each accepted mutation, SHALL return and persist versions 1, 2, and 3 respectively when starting from version 0, and SHALL allow the retry to use known version 2 and complete with version 3.

2.2 WHEN a command is rejected before mutation or an accepted command is replayed with the same idempotency identity THEN the Human_Bingo_System SHALL leave the authoritative state version and all game records unchanged, and SHALL return the original accepted result for an idempotent replay without performing a second version increment.

2.3 WHEN any verification command completes successfully THEN the Human_Bingo_System SHALL make the returned state version, persisted game state version, affected grid version, and next state-dependent command's required known version mutually consistent; a failed transaction SHALL publish none of its request, square, notification, completion, or version changes.

2.4 WHEN local development uses a local PostgreSQL target and the configured role `jpty` is absent THEN the documented bootstrap path SHALL create that role only if it is missing, SHALL configure the local connection prerequisites needed by the development database workflow, and SHALL continue to the existing bounded wait, idempotent database creation, and migration steps.

2.5 WHEN the local bootstrap is run again with the `jpty` role already present or after a prior bootstrap completed partially THEN the bootstrap SHALL succeed idempotently, SHALL not duplicate or reset the role, SHALL preserve existing local database data, SHALL not invoke destructive teardown or schema reset operations, and SHALL reject production-like targets before any role-changing operation.

2.6 WHEN Arch Linux browser validation is prepared THEN the documented workflow SHALL identify `sudo pacman -S chromium` as the supported system installation path, SHALL detect a usable system Chromium executable, and SHALL accept `PLAYWRIGHT_EXECUTABLE_PATH` as an explicit override for non-standard installations.

2.7 WHEN a usable Chromium executable is available through Playwright or the Arch system installation THEN the browser and accessibility suites SHALL launch in single-run headless mode using that executable; WHEN no executable is available THEN the browser check SHALL fail with an actionable message naming the installation or override remedy rather than reporting an ambiguous launch failure.

2.8 WHEN the runtime/local-development checkpoint is validated THEN the in-scope lint and format checks SHALL complete successfully with no unresolved findings or formatting drift, and the validation procedure SHALL run the fixed verification state-machine regression, the relevant unit/property checks, the idempotent local PostgreSQL bootstrap checks when local PostgreSQL is available, and the Chromium detection/browser checks when a supported executable is available.

2.9 WHEN a required external prerequisite is unavailable during validation THEN the validation procedure SHALL distinguish an environment-blocked check from a product failure, SHALL report the missing prerequisite and exact remediation, and SHALL leave production configuration and local persistent data untouched.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN verification commands use the current authoritative state version and are not in the request/reject/retry bug condition THEN the Human_Bingo_System SHALL CONTINUE TO enforce membership, same-game Player_Code, no self-verification, one pending request per square, identified-participant response authorization, closed-game rejection, and stale-state rejection.

3.2 WHEN a verification command is rejected for invalid input, stale state, duplicate pending work, unauthorized response, closed game, or failed persistence THEN the Human_Bingo_System SHALL CONTINUE TO preserve the existing request history, square status, notification state, completion records, and game version without partial mutation.

3.3 WHEN a valid verification request is created or resolved THEN the Human_Bingo_System SHALL CONTINUE TO create or resolve exactly one durable in-app notification, preserve resolved history, treat browser push as best effort, and update completion records only for confirmed squares.

3.4 WHEN local development connects with an already valid configured role, when the selected target is the isolated test database, or when the command is a non-destructive wait/create/migrate/status operation THEN the Human_Bingo_System SHALL CONTINUE TO use the existing target-selection, database-isolation, migration, redaction, and safety-guard behavior.

3.5 WHEN local development is stopped with the documented non-destructive Compose teardown THEN the Human_Bingo_System SHALL CONTINUE TO preserve the named PostgreSQL volume; destructive volume removal and development reset SHALL remain explicit, guarded operations and SHALL not be introduced into the bootstrap path.

3.6 WHEN Playwright-managed Chromium is installed or `PLAYWRIGHT_EXECUTABLE_PATH` is explicitly valid THEN the Human_Bingo_System SHALL CONTINUE TO use the existing browser-test base URL, web-server workflow, Chromium project, single-run semantics, and browser assertions without forcing an Arch-specific executable.

3.7 WHEN the verification property, runtime, database, browser, lint, or format checks are already passing and outside the reported blocker conditions THEN the Human_Bingo_System SHALL CONTINUE TO preserve their existing assertions, exit-code semantics, coverage expectations, and game-domain behavior.
