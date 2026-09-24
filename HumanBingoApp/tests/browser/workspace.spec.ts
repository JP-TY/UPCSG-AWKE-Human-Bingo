import { expect, test } from '@playwright/test';

test('browser harness is configured', async ({ page }) => {
  await page.setContent('<main><h1>Human Bingo</h1></main>');
  await expect(page.getByRole('heading', { name: 'Human Bingo' })).toBeVisible();
});
