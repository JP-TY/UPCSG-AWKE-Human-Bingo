import { expect, test, type Page } from '@playwright/test';

const timestamp = '2030-01-01T00:00:00.000Z';

function gameSnapshot() {
  const squares = Array.from({ length: 25 }, (_, squareIndex) => {
    const row = Math.floor(squareIndex / 5) + 1;
    const column = (squareIndex % 5) + 1;
    const status =
      squareIndex === 1
        ? 'pending'
        : squareIndex === 2
          ? 'rejected'
          : squareIndex === 3
            ? 'verified'
            : 'unverified';
    return {
      gridId: 'grid-1',
      squareIndex,
      row,
      column,
      taskEntryId: `task-${squareIndex}`,
      taskText: `Task ${squareIndex + 1}`,
      status,
      updatedAt: timestamp,
    };
  });
  return {
    game: {
      id: 'game-1',
      name: 'Team Bingo',
      status: 'active',
      distinctTaskCount: 25,
      taskBagLocked: true,
      stateVersion: 7,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    tasks: [],
    membership: {
      id: 'membership-1',
      gameId: 'game-1',
      participantId: 'participant-1',
      createdAt: timestamp,
      lastSeenAt: timestamp,
    },
    participant: { id: 'participant-1', displayName: 'Alex', joinedAt: timestamp },
    profile: {
      id: 'profile-1',
      participantId: 'participant-1',
      displayName: 'Alex',
      playerCode: 'ALEX01',
      createdAt: timestamp,
    },
    grid: {
      id: 'grid-1',
      gameId: 'game-1',
      participantId: 'participant-1',
      squares,
      taskBagVersion: 6,
      stateVersion: 7,
      createdAt: timestamp,
    },
    verificationRequests: [
      {
        id: 'request-pending',
        gameId: 'game-1',
        gridId: 'grid-1',
        squareIndex: 1,
        taskText: 'Task 2',
        requestingParticipant: {
          participantId: 'participant-2',
          displayName: 'Sam',
          playerCode: 'SAM002',
        },
        identifiedParticipant: {
          participantId: 'participant-1',
          displayName: 'Alex',
          playerCode: 'ALEX01',
        },
        status: 'pending',
        createdAt: timestamp,
      },
      {
        id: 'request-resolved',
        gameId: 'game-1',
        gridId: 'grid-1',
        squareIndex: 2,
        taskText: 'Task 3',
        requestingParticipant: {
          participantId: 'participant-1',
          displayName: 'Alex',
          playerCode: 'ALEX01',
        },
        identifiedParticipant: {
          participantId: 'participant-2',
          displayName: 'Sam',
          playerCode: 'SAM002',
        },
        status: 'rejected',
        createdAt: timestamp,
        resolvedAt: timestamp,
        decision: 'reject',
      },
    ],
    notifications: [
      {
        id: 'notification-pending',
        gameId: 'game-1',
        recipientParticipantId: 'participant-1',
        verificationRequestId: 'request-pending',
        kind: 'verification_request',
        status: 'pending',
        gameName: 'Team Bingo',
        requestingParticipant: {
          participantId: 'participant-2',
          displayName: 'Sam',
          playerCode: 'SAM002',
        },
        taskText: 'Task 2',
        createdAt: timestamp,
      },
      {
        id: 'notification-resolved',
        gameId: 'game-1',
        recipientParticipantId: 'participant-1',
        verificationRequestId: 'request-resolved',
        kind: 'verification_request',
        status: 'resolved',
        gameName: 'Team Bingo',
        requestingParticipant: {
          participantId: 'participant-1',
          displayName: 'Alex',
          playerCode: 'ALEX01',
        },
        taskText: 'Task 3',
        createdAt: timestamp,
        resolvedAt: timestamp,
      },
    ],
    leaderboards: {
      blackout: { category: 'blackout', totalCompletions: 0, entries: [] },
      line: { category: 'line', entries: [] },
      hashtag: { category: 'hashtag', totalCompletions: 0, entries: [] },
    },
    stateVersion: 7,
  };
}

async function setupMember(
  page: Page,
  options: { readonly closed?: boolean; readonly snapshot?: ReturnType<typeof gameSnapshot> } = {},
) {
  await page.route('**/api/session', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        session: {
          id: 'session-1',
          expiresAt: '2030-01-01T00:00:00.000Z',
          authorizationVersion: 1,
        },
      }),
    });
  });
  await page.route('**/api/games/game-1/snapshot**', async (route) => {
    const snapshot = options.snapshot ?? gameSnapshot();
    if (options.closed) snapshot.game.status = 'closed';
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ snapshot }),
    });
  });
}

test.describe('member grid and verification UI', () => {
  test('renders 25 semantic buttons with fill-color statuses and status labels', async ({ page }) => {
    await setupMember(page);
    await page.goto('/game/game-1');
    await expect(page.getByRole('heading', { name: 'Your 5×5 grid' })).toBeVisible();
    const grid = page.getByRole('grid', { name: 'Human Bingo task grid' });
    await expect(grid.getByRole('button')).toHaveCount(25);
    await expect(grid.getByRole('button', { name: /Row 1, column 1/ })).toHaveAttribute(
      'aria-label',
      /Status: Unverified/,
    );
    await expect(grid.getByRole('button', { name: /Row 1, column 2/ })).toHaveAttribute(
      'aria-label',
      /Status: Pending/,
    );
    await expect(grid.getByRole('button', { name: /Row 1, column 3/ })).toHaveAttribute(
      'aria-label',
      /Status: Rejected/,
    );
    await expect(grid.getByRole('button', { name: /Row 1, column 4/ })).toHaveAttribute(
      'aria-label',
      /Status: Verified/,
    );
    expect(await grid.locator('button.square--verified').count()).toBe(1);
    expect(await grid.locator('button.square--pending').count()).toBe(1);
    expect(await grid.locator('button.square--rejected').count()).toBe(1);
    expect(await grid.locator('button .square-position').count()).toBe(0);
    expect(await grid.locator('button .status').count()).toBe(0);
  });

  test('provides Player_Code validation and preserves the verification form focus', async ({
    page,
  }) => {
    await setupMember(page);
    await page.goto('/game/game-1');
    await page.getByRole('button', { name: /Row 1, column 1/ }).click();
    const code = page.getByLabel('Participant Player_Code');
    await code.fill('bad code');
    await page.getByRole('button', { name: 'Request verification' }).click();
    await expect(page.getByRole('alert')).toContainText('valid Player_Code');
    await expect(code).toBeFocused();
    await code.fill('alex01');
    await page.getByRole('button', { name: 'Request verification' }).click();
    await expect(page.getByRole('alert')).toContainText('Self-verification');
    await expect(code).toBeFocused();
  });

  test('closes the verification form and restores focus to the selected square', async ({
    page,
  }) => {
    await setupMember(page);
    await page.goto('/game/game-1');
    const square = page.getByRole('button', { name: /Row 1, column 1/ });
    await square.click();
    await expect(page.getByLabel('Participant Player_Code')).toBeVisible();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByLabel('Participant Player_Code')).toBeHidden();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(square).toBeFocused();
  });

  test('opens a popout modal with the maximized square and keeps it open across snapshot refreshes', async ({
    page,
  }) => {
    const initial = gameSnapshot();
    const updated = gameSnapshot();
    updated.stateVersion = 8;
    updated.game.stateVersion = 8;
    updated.grid.stateVersion = 8;
    updated.grid.squares[0]!.status = 'pending';
    await page.route('**/api/session', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          session: {
            id: 'session-1',
            expiresAt: '2030-01-01T00:00:00.000Z',
            authorizationVersion: 1,
          },
        }),
      });
    });
    let snapshotReads = 0;
    await page.route('**/api/games/game-1/snapshot**', async (route) => {
      snapshotReads += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ snapshot: snapshotReads === 1 ? initial : updated }),
      });
    });
    await page.route('**/api/games/game-1/verification-requests', async (route) => {
      await route.fulfill({ status: 204, body: '' });
    });
    await page.goto('/game/game-1');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: /Row 1, column 1/ }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Task 1');
    await expect(dialog.getByLabel('Participant Player_Code')).toBeVisible();
    await dialog.getByLabel('Participant Player_Code').fill('DAVE04');
    await dialog.getByRole('button', { name: 'Request verification' }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('This square is pending verification');
    expect(snapshotReads).toBe(2);
  });

  test('shows the pending alert inside the modal for a pending square', async ({ page }) => {
    await setupMember(page);
    await page.goto('/game/game-1');
    await page.getByRole('button', { name: /Row 1, column 2/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Waiting for Alex to respond');
    await expect(dialog.getByLabel('Participant Player_Code')).toHaveCount(0);
  });

  test('shows pending actions and resolved history without response controls for resolved requests', async ({
    page,
  }) => {
    await setupMember(page);
    await page.goto('/game/game-1/notifications');
    await expect(
      page.getByRole('heading', { name: 'Verification inbox (1 pending)' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Confirm verification request from Sam/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Reject verification request from Sam/ }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Request history' })).toBeVisible();
    await expect(page.locator('.notification-card--resolved').getByRole('button')).toHaveCount(0);
  });

  test('renders separate leaderboard categories, totals, and empty states', async ({ page }) => {
    const snapshot = gameSnapshot();
    snapshot.leaderboards = {
      blackout: {
        category: 'blackout',
        totalCompletions: 1,
        entries: [
          {
            participant: {
              participantId: 'participant-1',
              displayName: 'Alex',
              playerCode: 'ALEX01',
            },
            completionCount: 1,
            earliestCompletionAt: timestamp,
            completions: [],
          },
        ],
      },
      line: { category: 'line', entries: [] },
      hashtag: { category: 'hashtag', totalCompletions: 0, entries: [] },
    } as typeof snapshot.leaderboards;
    await setupMember(page, { snapshot });
    await page.goto('/game/game-1');

    await expect(page.getByRole('heading', { name: 'Leaderboards', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Blackout', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Line', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Hashtag', exact: true })).toBeVisible();
    await expect(page.locator('[data-leaderboard="blackout"]')).toContainText(
      '1 total blackout completions',
    );
    await expect(page.locator('[data-leaderboard="blackout"] .leaderboard-entry')).toHaveCount(1);
    await expect(page.locator('[data-leaderboard="line"]')).toContainText(
      'No line completions yet',
    );
    await expect(page.locator('[data-leaderboard="hashtag"]')).toContainText(
      'No hashtag completions yet',
    );
  });

  test('ranks every player by in-progress progress within each category leaderboard', async ({
    page,
  }) => {
    const snapshot = gameSnapshot();
    snapshot.leaderboards = {
      blackout: {
        category: 'blackout',
        totalCompletions: 1,
        entries: [
          {
            participant: {
              participantId: 'participant-1',
              displayName: 'Alex',
              playerCode: 'ALEX01',
            },
            completionCount: 1,
            earliestCompletionAt: timestamp,
            completions: [],
          },
        ],
      },
      line: { category: 'line', entries: [] },
      hashtag: { category: 'hashtag', totalCompletions: 0, entries: [] },
      progress: {
        category: 'progress',
        entries: [
          {
            participant: {
              participantId: 'participant-1',
              displayName: 'Alex',
              playerCode: 'ALEX01',
            },
            verifiedSquares: 12,
            qualifiedLines: 0,
            hashtagSquares: 7,
            bestLine: 3,
          },
          {
            participant: {
              participantId: 'participant-2',
              displayName: 'Sam',
              playerCode: 'SAM002',
            },
            verifiedSquares: 5,
            qualifiedLines: 0,
            hashtagSquares: 2,
            bestLine: 1,
          },
        ],
      },
    } as unknown as typeof snapshot.leaderboards;
    await setupMember(page, { snapshot });
    await page.goto('/game/game-1');

    const blackout = page.locator('[data-leaderboard="blackout"]');
    await expect(blackout.locator('.leaderboard-entry')).toHaveCount(2);
    await expect(blackout).toContainText('1 total blackout completions');
    await expect(blackout.locator('.leaderboard-entry').first()).toContainText('1. Alex');
    await expect(blackout.locator('.leaderboard-entry').first()).toContainText('12/25');
    await expect(blackout.locator('.leaderboard-entry').first()).toContainText('1 completion');
    await expect(blackout.locator('.leaderboard-entry').nth(1)).toContainText('Sam');
    await expect(blackout.locator('.leaderboard-entry').nth(1)).toContainText('5/25');
    const line = page.locator('[data-leaderboard="line"]');
    await expect(line.locator('.leaderboard-entry')).toHaveCount(2);
    await expect(line.locator('.leaderboard-entry').first()).toContainText('3/5');
    await expect(line.locator('.leaderboard-entry').first()).toContainText('best line');
    const hashtag = page.locator('[data-leaderboard="hashtag"]');
    await expect(hashtag.locator('.leaderboard-entry')).toHaveCount(2);
    await expect(hashtag.locator('.leaderboard-entry').first()).toContainText('7/16');
    await expect(hashtag.locator('.leaderboard-entry').first()).toContainText('hashtag squares');
    await expect(page.getByText('Overall progress')).toHaveCount(0);
  });

  test('shows closed-game read-only banner and preserves request history without response controls', async ({
    page,
  }) => {
    await setupMember(page, { closed: true });
    await page.goto('/game/game-1');
    await expect(page.locator('.alert--warning').filter({ hasText: 'Closed game' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Request history' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Verification history' })).toBeVisible();
    await expect(page.locator('.notification-card--resolved')).toContainText('Status: Rejected');
    await expect(page.locator('.verification-history-entry--rejected')).toContainText(
      'Status: Rejected',
    );
    await expect(page.locator('.notification-card--pending').getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('grid').getByRole('button')).toHaveCount(25);
    await expect(page.getByRole('grid').getByRole('button').first()).toBeDisabled();
    await expect(page.locator('[data-leaderboard="blackout"]')).toHaveAttribute(
      'data-state-version',
      '7',
    );
  });
  test('keeps the primary member view within the supported narrow viewport', async ({ page }) => {
    await setupMember(page);
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/game/game-1');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
  });
});

test.describe('synchronized member updates', () => {
  test('refreshes the affected square and leaderboards while preserving unrelated task text', async ({
    page,
  }) => {
    const initial = gameSnapshot();
    const updated = gameSnapshot();
    const longTask =
      'A long task description that must wrap inside one square without widening the primary game view';
    updated.stateVersion = 8;
    updated.game.stateVersion = 8;
    updated.grid.stateVersion = 8;
    updated.grid.squares[0]!.status = 'pending';
    updated.grid.squares[4]!.taskText = longTask;
    updated.verificationRequests = [
      {
        id: 'request-new',
        gameId: 'game-1',
        gridId: 'grid-1',
        squareIndex: 0,
        taskText: 'Task 1',
        requestingParticipant: {
          participantId: 'participant-1',
          displayName: 'Alex',
          playerCode: 'ALEX01',
        },
        identifiedParticipant: {
          participantId: 'participant-2',
          displayName: 'Sam',
          playerCode: 'SAM002',
        },
        status: 'pending',
        createdAt: timestamp,
      },
    ];

    await page.route('**/api/session', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          session: {
            id: 'session-1',
            expiresAt: '2030-01-01T00:00:00.000Z',
            authorizationVersion: 1,
          },
        }),
      });
    });
    let snapshotReads = 0;
    await page.route('**/api/games/game-1/snapshot**', async (route) => {
      snapshotReads += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ snapshot: snapshotReads === 1 ? initial : updated }),
      });
    });
    await page.route('**/api/games/game-1/verification-requests', async (route) => {
      await route.fulfill({ status: 204, body: '' });
    });

    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/game/game-1');
    const selected = page.getByRole('button', { name: /Row 1, column 1/ });
    await selected.click();
    await page.getByLabel('Participant Player_Code').fill('DAVE04');
    await page.getByRole('button', { name: 'Request verification' }).click();

    await expect(page.getByRole('button', { name: /Row 1, column 1.*Pending/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Row 1, column 5/ })).toContainText(longTask);
    await expect(page.locator('[data-leaderboard="blackout"]')).toHaveAttribute(
      'data-state-version',
      '8',
    );
    await expect(page.locator('[data-leaderboard="line"]')).toHaveAttribute(
      'data-state-version',
      '8',
    );
    await expect(page.locator('[data-leaderboard="hashtag"]')).toHaveAttribute(
      'data-state-version',
      '8',
    );
    expect(snapshotReads).toBe(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
  });
});

test.describe('identity stability across a shared browser session', () => {
  test('keeps the adopted identity when the shared session is rebound to another player', async ({
    page,
  }) => {
    await page.route('**/api/session', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          session: {
            id: 'session-1',
            expiresAt: '2030-01-01T00:00:00.000Z',
            authorizationVersion: 1,
          },
        }),
      });
    });
    const bob = gameSnapshot();
    bob.membership = { ...bob.membership, id: 'membership-2', participantId: 'participant-2' };
    bob.participant = { id: 'participant-2', displayName: 'Bob', joinedAt: timestamp };
    bob.profile = {
      ...bob.profile,
      id: 'profile-2',
      participantId: 'participant-2',
      displayName: 'Bob',
      playerCode: 'BOB002',
    };
    bob.grid = { ...bob.grid, participantId: 'participant-2' };
    let snapshotReads = 0;
    await page.route('**/api/games/game-1/snapshot**', async (route) => {
      snapshotReads += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ snapshot: snapshotReads === 1 ? gameSnapshot() : bob }),
      });
    });

    await page.goto('/game/game-1');
    await expect(page.getByRole('heading', { name: 'Welcome back, Alex' })).toBeVisible();

    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

    await expect(page.getByRole('heading', { name: 'Welcome back, Alex' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Welcome back, Bob' })).toHaveCount(0);
    await expect(page.locator('.alert--warning')).toContainText(
      'Another player joined in this browser',
    );
    await expect(page.locator('.alert--warning')).toContainText('now signed in as Bob');
    expect(snapshotReads).toBeGreaterThanOrEqual(2);
  });
});

test.describe('resume the last game on revisit', () => {
  test('shows the resume card on the home page and rejoins the game', async ({ page }) => {
    await setupMember(page);
    await page.addInitScript(() => {
      localStorage.setItem(
        'human-bingo:resume-game',
        JSON.stringify({ gameId: 'game-1', name: 'Team Bingo' }),
      );
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Resume your game' })).toBeVisible();
    await expect(page.locator('.card').first()).toContainText('Team Bingo');
    await page.getByRole('link', { name: 'Rejoin game' }).click();
    await expect(page).toHaveURL(/\/game\/game-1$/);
    await expect(page.getByRole('heading', { name: 'Your 5×5 grid' })).toBeVisible();
  });

  test('keeps the home page plain when no game was resumed', async ({ page }) => {
    await setupMember(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Resume your game' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Start with an invitation' })).toBeVisible();
  });
});
