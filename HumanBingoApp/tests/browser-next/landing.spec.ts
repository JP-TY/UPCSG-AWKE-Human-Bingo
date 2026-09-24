import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('home leads with the supplied AKWE hero artwork and clear game entry points', async ({
  page,
}) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Human Bingo' })).toBeVisible();
  await expect(page.getByRole('img', { name: /AKWE 2026 scrapbook board/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Join a game' }).first()).toHaveAttribute(
    'href',
    '/join',
  );
  await expect(page.getByRole('link', { name: 'Host a game' }).first()).toHaveAttribute(
    'href',
    '/host',
  );
});

test('join form validates a short code before making a network request', async ({ page }) => {
  await page.goto('/join');
  await page.waitForLoadState('networkidle');
  const code = page.getByLabel('Six-character join code');
  let invitationRequestStarted = false;
  page.on('request', (request) => {
    if (request.url().includes('/api/invitations/resolve')) invitationRequestStarted = true;
  });
  await code.fill('ABC');
  expect(await code.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
  await code.blur();

  await expect(page.locator('.form-message--error')).toContainText('exactly six');
  expect(invitationRequestStarted).toBe(false);
});

test('home and join remain readable without horizontal scrolling at phone widths', async ({
  page,
}) => {
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 860 });
    await page.goto('/');
    const homeWidths = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(homeWidths.scroll, `home at ${width}px`).toBeLessThanOrEqual(homeWidths.client);

    await page.goto('/join');
    const joinWidths = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(joinWidths.scroll, `join at ${width}px`).toBeLessThanOrEqual(joinWidths.client);
  }
});

test('home and join meet axe WCAG AA checks', async ({ page }) => {
  for (const route of ['/', '/join']) {
    await page.goto(route);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, `${route} axe violations`).toEqual([]);
  }
});
