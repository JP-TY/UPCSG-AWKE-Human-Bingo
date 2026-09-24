import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { gameId, gridId } from '../fixtures/game-snapshot.mjs';

test.beforeEach(async ({ page }) => {
  await fetch('http://127.0.0.1:3013/test/reset', { method: 'POST' });
  await page.routeWebSocket(/\/ws\?/, (socket) => {
    socket.onMessage(() => undefined);
  });
});

test('renders 25 task squares and stamps verified squares only', async ({ page }) => {
  await page.goto(`/game/${gameId}`);
  const grid = page.getByRole('grid', { name: 'Human Bingo task grid' });
  await expect(grid).toBeVisible();
  await expect(grid.getByRole('button')).toHaveCount(25);

  const verified = grid.getByRole('button', { name: /Row 1, column 1.*Verified/ });
  await expect(verified).toBeDisabled();
  await expect(verified.locator('.face-stamp')).toHaveCount(1);
  await expect(
    grid.getByRole('button', { name: /Row 1, column 2.*Pending/ }).locator('.face-stamp'),
  ).toHaveCount(0);
  await expect(
    grid.getByRole('button', { name: /Row 1, column 3.*Rejected/ }).locator('.face-stamp'),
  ).toHaveCount(0);
});

test('lets a player request verification using the current state version', async ({ page }) => {
  await page.goto(`/game/${gameId}`);
  const grid = page.getByRole('grid', { name: 'Human Bingo task grid' });
  await grid.getByRole('button', { name: /Row 1, column 4/ }).click();
  await page.getByLabel('Participant Player_Code').fill('J01234');
  await page.getByRole('button', { name: 'Request verification' }).click();

  await expect(page.locator('.form-message--success')).toContainText('Request sent');
  const commandResponse = await fetch('http://127.0.0.1:3013/test/last-command');
  const { command } = (await commandResponse.json()) as {
    readonly command: Record<string, unknown>;
  };
  expect(command).toMatchObject({
    gridId,
    squareIndex: 3,
    identifiedPlayerCode: 'J01234',
    knownStateVersion: 1,
  });
  await expect(grid.getByRole('button', { name: /Row 1, column 4.*Pending/ })).toBeVisible();
});

test('game board fits phone width and meets axe WCAG AA checks', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 850 });
  await page.goto(`/game/${gameId}`);
  await expect(page.getByRole('grid', { name: 'Human Bingo task grid' })).toBeVisible();

  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations, 'game board axe violations').toEqual([]);
});
