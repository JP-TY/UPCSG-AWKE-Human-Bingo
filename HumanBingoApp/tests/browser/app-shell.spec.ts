import { expect, test } from '@playwright/test';

test.describe('Human Bingo app shell', () => {
  test('renders the home route and navigates to the join flow', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('Human Bingo');
    await expect(page.getByRole('heading', { name: 'Human Bingo' })).toBeVisible();
    await page.getByRole('link', { name: 'Join a game' }).click();
    await expect(page).toHaveURL(/\/join$/);
    await expect(page.getByRole('heading', { name: 'Join a game' })).toBeVisible();
  });

  test('provides accessible validation and keeps the primary view within a 320px viewport', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/join');
    const code = page.getByLabel('Six-character join code');
    await code.fill('bad');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toContainText('exactly six');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
  });

  test('renders invitation and member routes without exposing session errors', async ({ page }) => {
    await page.route('**/api/session', async (route) => {
      await route.fulfill({ status: 404, contentType: 'application/json', body: '' });
    });
    await page.route('**/api/invitations/example-token', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          preview: {
            gameId: 'game-1',
            gameName: 'Team Bingo',
            gameStatus: 'invitation_available',
            invitationStatus: 'available',
            joinCode: 'ABC123',
          },
        }),
      });
    });
    await page.goto('/invite/example-token');
    await expect(page.getByRole('heading', { name: 'Invitation preview' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue to onboarding' }).click();
    await expect(page).toHaveURL(/\/join\?token=/);
    await page.goto('/game/game-1');
    await expect(page.getByRole('heading', { name: 'Your game' })).toBeVisible();
    await expect(page.getByText('Resume access is required')).toBeVisible();
  });

  test('bootstraps an authenticated session before showing member controls', async ({ page }) => {
    await page.route('**/api/session', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          session: {
            id: 'session-1',
            membershipId: 'membership-1',
            expiresAt: '2030-01-01T00:00:00.000Z',
            authorizationVersion: 1,
          },
        }),
      });
    });

    await page.goto('/game/game-1');
    await expect(page.getByRole('heading', { name: 'Your game' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Synchronized game view' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Home' })).toBeVisible();
  });

  test('keeps invitation bearer tokens out of rendered content and exposes visible keyboard focus', async ({
    page,
  }) => {
    await page.goto('/invite/private-token');
    await expect(page.getByText('private-token')).not.toBeVisible();
    await page.goto('/join');
    await page.getByLabel('Six-character join code').focus();
    await expect(page.getByLabel('Six-character join code')).toHaveCSS('outline-width', '3px');
  });
});

test.describe('host and onboarding flows', () => {
  const game = {
    id: 'game-1',
    name: 'Team Bingo',
    status: 'invitation_available',
    distinctTaskCount: 25,
    taskBagLocked: false,
    stateVersion: 4,
    createdAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-01T00:00:00.000Z',
  };

  test('presents host task setup and invitation representations accessibly', async ({ page }) => {
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
    await page.route('**/api/games/game-1/host', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          game,
          tasks: [
            {
              id: 'task-1',
              text: 'Has a bicycle',
              createdAt: game.createdAt,
              updatedAt: game.updatedAt,
            },
          ],
          invitation: {
            invitationId: 'invitation-1',
            gameId: 'game-1',
            joinCode: 'ABC123',
            canonicalLink: 'https://app.example/invite/opaque-token',
            qrPayload: 'https://app.example/invite/opaque-token',
            status: 'available',
          },
        }),
      });
    });

    await page.goto('/game/game-1/host');
    await expect(page.getByRole('heading', { name: 'Host setup' })).toBeVisible();
    await expect(page.getByText('ABC123')).toBeVisible();
    await expect(page.getByLabel('QR code for the invitation link')).toBeVisible();
    await expect(page.getByLabel('QR code for the invitation link')).toHaveAttribute(
      'data-qr-payload',
      'https://app.example/invite/opaque-token',
    );
    await expect(page.getByRole('textbox', { name: 'Invitation link' })).toHaveValue(
      'https://app.example/invite/opaque-token',
    );
  });

  test('resolves an invitation before onboarding and displays the returned Player_Code', async ({
    page,
  }) => {
    let onboardingRequests = 0;
    await page.route('**/api/session', async (route) => {
      await route.fulfill({
        status: onboardingRequests > 0 ? 200 : 404,
        contentType: 'application/json',
        body:
          onboardingRequests > 0
            ? JSON.stringify({
                session: {
                  id: 'session-2',
                  expiresAt: '2030-01-01T00:00:00.000Z',
                  authorizationVersion: 1,
                },
              })
            : '',
      });
    });
    await page.route('**/api/invitations/ABC123', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          preview: {
            gameId: 'game-1',
            gameName: 'Team Bingo',
            gameStatus: 'invitation_available',
            invitationStatus: 'available',
            joinCode: 'ABC123',
          },
        }),
      });
    });
    await page.route('**/api/games/game-1/onboarding', async (route) => {
      onboardingRequests += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          onboarding: {
            game: { ...game, status: 'active', taskBagLocked: true },
            membership: {
              id: 'membership-1',
              gameId: 'game-1',
              participantId: 'participant-1',
              createdAt: game.createdAt,
              lastSeenAt: game.updatedAt,
            },
            participant: { id: 'participant-1', displayName: 'Alex', joinedAt: game.createdAt },
            profile: {
              id: 'profile-1',
              participantId: 'participant-1',
              displayName: 'Alex',
              playerCode: 'P7K2M9',
              createdAt: game.createdAt,
            },
            grid: {
              id: 'grid-1',
              gameId: 'game-1',
              participantId: 'participant-1',
              squares: [],
              taskBagVersion: 4,
              stateVersion: 5,
              createdAt: game.createdAt,
            },
            resumed: false,
            stateVersion: 5,
          },
        }),
      });
    });

    await page.goto('/join');
    await page.getByLabel('Six-character join code').fill('abc123');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Join Human Bingo' })).toBeVisible();
    expect(onboardingRequests).toBe(0);
    await page.getByLabel('Display name').fill('Alex');
    await page.getByRole('button', { name: 'Complete onboarding' }).click();
    await expect(page.getByRole('heading', { name: 'You joined the game' })).toBeVisible();
    await expect(page.getByLabel('Your Player Code')).toHaveText('P7K2M9');
  });
});

test.describe('host validation and resumable invitations', () => {
  const timestamp = '2030-01-01T00:00:00.000Z';
  const longTask = 'Find someone who can describe their favorite travel memory in great detail';

  test('preserves the task bag while showing blank and duplicate validation errors', async ({
    page,
  }) => {
    const draftGame = {
      id: 'game-1',
      name: 'Draft Bingo',
      status: 'draft',
      distinctTaskCount: 24,
      taskBagLocked: false,
      stateVersion: 3,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    let mutationCount = 0;
    await page.route('**/api/session', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          session: {
            id: 'host-session',
            expiresAt: '2030-01-01T00:00:00.000Z',
            authorizationVersion: 1,
          },
        }),
      });
    });
    await page.route('**/api/games/game-1/host', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          game: draftGame,
          tasks: [
            { id: 'task-1', text: 'Has a bicycle', createdAt: timestamp, updatedAt: timestamp },
            { id: 'task-2', text: longTask, createdAt: timestamp, updatedAt: timestamp },
          ],
        }),
      });
    });
    await page.route('**/api/games/game-1', async (route) => {
      mutationCount += 1;
      const body = route.request().postDataJSON() as { text?: string };
      if (body.text?.trim() === '') {
        await route.fulfill({
          status: 422,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'Task text is required.' } }),
        });
        return;
      }
      if (body.text?.trim().toLowerCase() === 'has a bicycle') {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'This task is a duplicate.' } }),
        });
        return;
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          game: { ...draftGame, stateVersion: 4 },
          tasks: [
            { id: 'task-1', text: 'Has a bicycle', createdAt: timestamp, updatedAt: timestamp },
            {
              id: 'task-2',
              text: body.text?.trim() ?? longTask,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
        }),
      });
    });

    await page.goto('/game/game-1/host');
    await expect(page.getByRole('button', { name: 'Open invitations' })).toBeDisabled();
    await expect(page.getByText('Add 1 more distinct task to open this game.')).toBeVisible();

    const longTaskInput = page.getByRole('textbox', { name: `Task ${longTask}` });
    await longTaskInput.fill('   ');
    await page.locator('.task-row').nth(1).getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert')).toContainText('Task text is required');
    await expect(page.getByRole('textbox', { name: `Task ${longTask}` })).toHaveValue(longTask);

    await page.getByRole('textbox', { name: `Task ${longTask}` }).fill('  Has a bicycle  ');
    await page.locator('.task-row').nth(1).getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert')).toContainText('duplicate');
    await expect(page.getByRole('textbox', { name: `Task ${longTask}` })).toHaveValue(longTask);

    await page.getByRole('textbox', { name: `Task ${longTask}` }).fill(`  ${longTask}  `);
    await page.locator('.task-row').nth(1).getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('textbox', { name: `Task ${longTask}` })).toHaveValue(longTask);
    expect(mutationCount).toBe(3);
  });

  test('locks task controls after the first participant joins', async ({ page }) => {
    await page.route('**/api/session', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          session: {
            id: 'host-session',
            expiresAt: '2030-01-01T00:00:00.000Z',
            authorizationVersion: 1,
          },
        }),
      });
    });
    await page.route('**/api/games/game-1/host', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          game: {
            id: 'game-1',
            name: 'Active Bingo',
            status: 'active',
            distinctTaskCount: 25,
            taskBagLocked: true,
            stateVersion: 8,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          tasks: [{ id: 'task-1', text: longTask, createdAt: timestamp, updatedAt: timestamp }],
        }),
      });
    });

    await page.goto('/game/game-1/host');
    await expect(
      page.getByText('The task bag is locked after the first participant joined.'),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: `Task ${longTask}` })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeDisabled();
    await expect(page.getByRole('textbox', { name: 'New task' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Add task' })).toBeDisabled();
  });

  test('allows the same invitation to be resolved again and resumes the existing Player_Code', async ({
    page,
  }) => {
    let onboardingCalls = 0;
    const profile = {
      id: 'profile-1',
      participantId: 'participant-1',
      displayName: 'Alex',
      playerCode: 'P7K2M9',
      createdAt: timestamp,
    };
    const onboarding = (resumed: boolean) => ({
      game: {
        id: 'game-1',
        name: 'Team Bingo',
        status: 'active',
        distinctTaskCount: 25,
        taskBagLocked: true,
        stateVersion: 5,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      membership: {
        id: 'membership-1',
        gameId: 'game-1',
        participantId: 'participant-1',
        createdAt: timestamp,
        lastSeenAt: timestamp,
      },
      participant: { id: 'participant-1', displayName: 'Alex', joinedAt: timestamp },
      profile,
      grid: {
        id: 'grid-1',
        gameId: 'game-1',
        participantId: 'participant-1',
        squares: [],
        taskBagVersion: 4,
        stateVersion: 5,
        createdAt: timestamp,
      },
      resumed,
      stateVersion: 5,
    });
    await page.route('**/api/session', async (route) => {
      await route.fulfill({
        status: onboardingCalls === 0 ? 404 : 200,
        contentType: 'application/json',
        body:
          onboardingCalls === 0
            ? ''
            : JSON.stringify({
                session: {
                  id: 'session-2',
                  expiresAt: '2030-01-01T00:00:00.000Z',
                  authorizationVersion: 1,
                },
              }),
      });
    });
    await page.route('**/api/invitations/opaque-token', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          preview: {
            gameId: 'game-1',
            gameName: 'Team Bingo',
            gameStatus: 'invitation_available',
            invitationStatus: 'available',
            joinCode: 'ABC123',
          },
        }),
      });
    });
    await page.route('**/api/games/game-1/onboarding', async (route) => {
      const resumed = onboardingCalls > 0;
      onboardingCalls += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ onboarding: onboarding(resumed) }),
      });
    });

    await page.goto('/invite/opaque-token');
    await expect(page.getByRole('button', { name: 'Continue to onboarding' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue to onboarding' }).click();
    await page.getByLabel('Display name').fill('Alex');
    await page.getByRole('button', { name: 'Complete onboarding' }).click();
    await expect(page.getByRole('heading', { name: 'You joined the game' })).toBeVisible();
    await expect(page.getByLabel('Your Player Code')).toHaveText('P7K2M9');

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Join Human Bingo' })).toBeVisible();
    await page.getByLabel('Display name').fill('Alex again');
    await page.getByRole('button', { name: 'Complete onboarding' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expect(page.getByLabel('Your Player Code')).toHaveText('P7K2M9');
    expect(onboardingCalls).toBe(2);
  });
});

test('shows a closed invitation as unavailable without opening onboarding', async ({ page }) => {
  let onboardingRequests = 0;
  await page.route('**/api/session', async (route) => {
    await route.fulfill({ status: 404, contentType: 'application/json', body: '' });
  });
  await page.route('**/api/invitations/closed-token', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        preview: {
          gameId: 'game-closed',
          gameName: 'Closed Bingo',
          gameStatus: 'closed',
          invitationStatus: 'revoked',
          joinCode: 'ABC123',
        },
      }),
    });
  });
  await page.route('**/api/games/game-closed/onboarding', async (route) => {
    onboardingRequests += 1;
    await route.fulfill({ status: 409, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/invite/closed-token');
  await expect(
    page.getByText('This invitation is no longer accepting participants.'),
  ).toBeVisible();
  await expect(page.locator('.alert--warning')).toContainText('Invitation closed');
  await expect(page.getByRole('button', { name: 'Continue to onboarding' })).toHaveCount(0);
  expect(onboardingRequests).toBe(0);
});
