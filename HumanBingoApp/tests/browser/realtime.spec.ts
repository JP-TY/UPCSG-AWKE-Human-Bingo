import { expect, test, type Page } from '@playwright/test';

const timestamp = '2030-01-01T00:00:00.000Z';

function buildSnapshot(version: number, verifiedSquares: readonly number[] = []) {
  const squares = Array.from({ length: 25 }, (_, squareIndex) => {
    const row = Math.floor(squareIndex / 5) + 1;
    const column = (squareIndex % 5) + 1;
    return {
      gridId: 'grid-1',
      squareIndex,
      row,
      column,
      taskEntryId: `task-${squareIndex}`,
      taskText: `Task ${squareIndex + 1}`,
      status: verifiedSquares.includes(squareIndex) ? 'verified' : 'unverified',
      updatedAt: timestamp,
    };
  });
  return {
    game: {
      id: 'game-1',
      name: 'Realtime Bingo',
      status: 'active',
      distinctTaskCount: 25,
      taskBagLocked: true,
      stateVersion: version,
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
      stateVersion: version,
      createdAt: timestamp,
    },
    verificationRequests: [],
    notifications: [],
    leaderboards: {
      blackout: { category: 'blackout', totalCompletions: 0, entries: [] },
      line: { category: 'line', entries: [] },
      hashtag: { category: 'hashtag', totalCompletions: 0, entries: [] },
    },
    stateVersion: version,
  };
}

async function setupRealtime(
  page: Page,
  onSynchronized: (version: number, send: (data: string) => void) => void,
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

  let reads = 0;
  await page.route('**/api/games/game-1/snapshot**', async (route) => {
    reads += 1;
    const snapshot = reads === 1 ? buildSnapshot(7) : buildSnapshot(8, [0]);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ snapshot }) });
  });

  await page.routeWebSocket('**/ws?*', (ws) => {
    ws.onMessage((data) => {
      const message = JSON.parse(String(data)) as { readonly type?: string; readonly stateVersion?: number };
      if (message?.type === 'synchronized')
        onSynchronized(Number(message.stateVersion), (data) => ws.send(data));
    });
  });

  return { reads: () => reads };
}

test.describe('realtime browser updates', () => {
  test('applies a server-side game.patch after the snapshot acknowledgement without a manual refresh', async ({
    page,
  }) => {
    let patched = false;
    const realtime = await setupRealtime(page, (version, send) => {
      if (!patched && version === 7) {
        patched = true;
        send(
          JSON.stringify({
            type: 'game.patch',
            gameId: 'game-1',
            stateVersion: 8,
            previousStateVersion: 7,
            eventId: 'realtime-event-2',
            changes: {},
          }),
        );
      }
    });

    await page.goto('/game/game-1');
    const grid = page.getByRole('grid', { name: 'Human Bingo task grid' });
    await expect(grid.getByRole('button')).toHaveCount(25);

    await expect(page.getByRole('button', { name: /Row 1, column 1.*Verified/ })).toBeVisible();

    expect(patched).toBe(true);
    expect(realtime.reads()).toBe(2);
    expect(page.url()).toContain('/game/game-1');
  });
});
