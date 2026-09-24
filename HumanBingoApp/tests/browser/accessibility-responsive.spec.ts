import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const gameFixture = `
  <!doctype html>
  <html lang="en">
    <head>
      <title>Team Human Bingo</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
    </head>
    <body>
    <style>
    :root { color-scheme: light; font-family: system-ui, sans-serif; color: #172033; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; }
    a, button, input { font: inherit; }
    :focus-visible { outline: 3px solid #f2a900; outline-offset: 3px; }
    .game-view { width: min(100% - 2rem, 72rem); margin: 0 auto; padding: 1rem 0; }
    .game-navigation { display: flex; flex-wrap: wrap; gap: .5rem; margin-block: 1rem; }
    .game-panel { display: grid; gap: 1rem; min-width: 0; }
    .bingo-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: .35rem; }
    .square { min-width: 0; min-height: 3.5rem; overflow-wrap: anywhere; }
    .status { display: inline-flex; gap: .25rem; }
    .status::before { content: ''; width: .75rem; height: .75rem; border: 1px solid currentColor; }
    .status[data-status='pending']::before { border-radius: 50%; }
    .status[data-status='rejected']::before { background: currentColor; }
    .status[data-status='verified']::before { background: currentColor; border-radius: 50%; }
    .leaderboards { display: grid; gap: 1rem; }
    .leaderboard { border: 1px solid #536176; padding: 1rem; }
    dialog { width: min(calc(100% - 2rem), 32rem); }
    @media (min-width: 600px) { .game-panel { grid-template-columns: minmax(0, 2fr) minmax(16rem, 1fr); } }
    @media (min-width: 1024px) { .game-view { padding-block: 2rem; } .leaderboards { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; }
    }
  </style>
  <main class="game-view" id="game-main">
    <header>
      <h1>Team Human Bingo</h1>
      <p id="game-help">Select a square and ask another participant to verify it.</p>
      <nav class="game-navigation" aria-label="Game navigation">
        <a href="#grid">Grid</a>
        <a href="#notifications">Notifications <span aria-label="2 pending actions">2</span></a>
        <a href="#leaderboards">Leaderboards</a>
        <a href="#invitation">Invitation</a>
      </nav>
    </header>
    <div class="game-panel">
      <section id="grid" aria-labelledby="grid-heading">
        <h2 id="grid-heading">Your grid</h2>
        <div class="bingo-grid" role="group" aria-label="Human Bingo grid">
          ${Array.from({ length: 25 }, (_, index) => {
            const row = Math.floor(index / 5) + 1;
            const column = (index % 5) + 1;
            return `<button class="square" type="button" aria-label="Row ${row}, column ${column}, Has a bicycle, Unverified" data-square="${index}">Has a bicycle <span class="status" data-status="unverified"><span aria-hidden="true">○</span><span>Unverified</span></span></button>`;
          }).join('')}
        </div>
      </section>
      <section id="verification" aria-labelledby="verification-heading">
        <h2 id="verification-heading">Verification</h2>
        <p>Select a square to request confirmation from another participant.</p>
        <output id="announcement" role="status" aria-live="polite"></output>
      </section>
    </div>
    <section id="invitation" aria-labelledby="invitation-heading">
      <h2 id="invitation-heading">Invitation</h2>
      <label for="invitation-link">Invitation link</label>
      <input id="invitation-link" readonly value="https://app.example/invite/opaque-token">
      <button type="button" id="copy-invitation">Copy invitation link</button>
      <div role="img" aria-label="QR code for the invitation link" data-qr-payload="https://app.example/invite/opaque-token">QR invitation</div>
    </section>
    <section id="notifications" aria-labelledby="notifications-heading">
      <h2 id="notifications-heading">Notifications</h2>
      <article aria-labelledby="request-heading">
        <h3 id="request-heading">Alex asks you to verify Has a bicycle</h3>
        <button type="button" id="confirm-request">Confirm request</button>
        <button type="button" id="reject-request">Reject request</button>
      </article>
    </section>
    <section id="leaderboards" aria-labelledby="leaderboards-heading">
      <h2 id="leaderboards-heading">Leaderboards</h2>
      <nav aria-label="Leaderboard navigation">
        <a href="#blackout">Blackout</a>
        <a href="#line">Line</a>
        <a href="#hashtag">Hashtag</a>
      </nav>
      <div class="leaderboards">
        <section class="leaderboard" id="blackout" aria-labelledby="blackout-heading"><h3 id="blackout-heading">Blackout</h3><p>0 completions</p></section>
        <section class="leaderboard" id="line" aria-labelledby="line-heading"><h3 id="line-heading">Line</h3><p>No line completions yet.</p></section>
        <section class="leaderboard" id="hashtag" aria-labelledby="hashtag-heading"><h3 id="hashtag-heading">Hashtag</h3><p>No hashtag completions yet.</p></section>
      </div>
    </section>
    <dialog id="verification-dialog" aria-labelledby="verification-dialog-heading">
      <form method="dialog" id="verification-form">
        <h2 id="verification-dialog-heading">Verify this square</h2>
        <p id="selected-square">Has a bicycle</p>
        <label for="player-code">Player Code</label>
        <input id="player-code" name="playerCode" required pattern="[A-Z0-9]{6}" autocomplete="off">
        <button type="submit" id="submit-verification">Send verification request</button>
        <button type="button" id="close-verification">Cancel</button>
      </form>
    </dialog>
  </main>
    </body>
  </html>
`;
async function addGameFixtureBehavior(page: Page): Promise<void> {
  await page.evaluate(() => {
    const dialog = document.querySelector<HTMLDialogElement>('#verification-dialog');
    const announcement = document.querySelector<HTMLOutputElement>('#announcement');
    const firstSquare = document.querySelector<HTMLButtonElement>('[data-square="0"]');
    const close = document.querySelector<HTMLButtonElement>('#close-verification');
    const form = document.querySelector<HTMLFormElement>('#verification-form');
    const confirm = document.querySelector<HTMLButtonElement>('#confirm-request');
    const reject = document.querySelector<HTMLButtonElement>('#reject-request');
    if (!dialog || !announcement || !firstSquare || !close || !form || !confirm || !reject)
      throw new Error('Game fixture controls were not found.');
    firstSquare.addEventListener('click', () => dialog.showModal());
    close.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      dialog.close();
      firstSquare.setAttribute('aria-label', 'Row 1, column 1, Has a bicycle, Pending');
      firstSquare
        .querySelector('.status')
        ?.replaceChildren(
          Object.assign(document.createElement('span'), { textContent: '◌' }),
          Object.assign(document.createElement('span'), { textContent: 'Pending' }),
        );
      firstSquare.querySelector('.status')?.setAttribute('data-status', 'pending');
      announcement.textContent = 'Verification request sent. Square is pending.';
    });
    confirm.addEventListener('click', () => {
      confirm.disabled = true;
      reject.disabled = true;
      announcement.textContent = 'Verification request confirmed.';
    });
    reject.addEventListener('click', () => {
      confirm.disabled = true;
      reject.disabled = true;
      announcement.textContent = 'Verification request rejected.';
    });
  });
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

async function navigateSpa(page: Page, path: string): Promise<void> {
  await page.goto('/');
  await page.evaluate((nextPath) => {
    window.history.pushState({}, '', nextPath);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

test.describe('accessibility and responsive validation', () => {
  test('runs axe checks on the home and join flows', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Human Bingo' })).toBeVisible();
    await expectNoAxeViolations(page);

    await navigateSpa(page, '/join');
    await expect(page.getByRole('heading', { name: 'Join a game' })).toBeVisible();
    await expectNoAxeViolations(page);
    await page.getByLabel('Six-character join code').focus();
    await expect(page.getByLabel('Six-character join code')).toHaveCSS('outline-width', '3px');
  });

  test('supports keyboard-only invitation and host controls with accessible names', async ({
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
    await page.route('**/api/games/game-1/host', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          game: {
            id: 'game-1',
            name: 'Team Bingo',
            status: 'invitation_available',
            distinctTaskCount: 25,
            taskBagLocked: false,
            stateVersion: 4,
            createdAt: '2030-01-01T00:00:00.000Z',
            updatedAt: '2030-01-01T00:00:00.000Z',
          },
          tasks: [],
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

    await navigateSpa(page, '/game/game-1/host');
    await expect(page.getByRole('heading', { name: 'Host setup' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'QR code for the invitation link' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Invitation link' }).focus();
    await expect(page.getByRole('textbox', { name: 'Invitation link' })).toHaveCSS(
      'outline-width',
      '3px',
    );
    await expectNoAxeViolations(page);

    await navigateSpa(page, '/invite/example-token');
    await expect(page.getByRole('heading', { name: 'Invitation preview' })).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test('exercises keyboard grid selection, verification dialog, notification actions, and leaderboard navigation', async ({
    page,
  }) => {
    await page.setContent(gameFixture);
    await addGameFixtureBehavior(page);
    await expectNoAxeViolations(page);

    const firstSquare = page.getByRole('button', { name: /Row 1, column 1/ });
    await firstSquare.focus();
    await expect(firstSquare).toHaveCSS('outline-width', '3px');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Verify this square' })).toBeVisible();
    await page.getByLabel('Player Code').fill('P7K2M9');
    await page.getByRole('button', { name: 'Send verification request' }).click();
    await expect(page.getByRole('status')).toContainText('Verification request sent');
    await expect(page.getByRole('button', { name: /Pending/ })).toBeVisible();

    await page.getByRole('button', { name: 'Confirm request' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText('confirmed');
    await expect(page.getByRole('button', { name: 'Confirm request' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Reject request' })).toBeDisabled();

    await page.getByRole('link', { name: 'Line' }).focus();
    await expect(page.getByRole('link', { name: 'Line' })).toHaveCSS('outline-width', '3px');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#line$/);
    await expect(page.getByRole('heading', { name: 'Line' })).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test('keeps responsive game views usable at 320, 600, and 1024 pixel breakpoints', async ({
    page,
  }) => {
    for (const width of [320, 600, 1024]) {
      await page.setViewportSize({ width, height: 800 });
      await page.setContent(gameFixture);
      await addGameFixtureBehavior(page);
      await expect(page.locator('body')).toHaveJSProperty('scrollWidth', width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      const columns = await page
        .locator('.bingo-grid')
        .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
      expect(columns).toBe(5);
      const panelColumns = await page
        .locator('.game-panel')
        .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
      expect(panelColumns).toBe(width >= 600 ? 2 : 1);
      const leaderboardColumns = await page
        .locator('.leaderboards')
        .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
      expect(leaderboardColumns).toBe(width >= 1024 ? 3 : 1);
    }
  });

  test('uses non-color status indicators and honors reduced-motion preferences', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setContent(gameFixture);
    await addGameFixtureBehavior(page);

    const statuses = page.locator('.status');
    await expect(statuses).toHaveCount(25);
    for (let index = 0; index < 25; index += 1) {
      const status = statuses.nth(index);
      await expect(status).toContainText('Unverified');
      await expect(status).toHaveAttribute('data-status', 'unverified');
      await expect(status.locator('[aria-hidden="true"]')).toHaveCount(1);
    }
    const motion = await page.locator('body').evaluate(() => {
      const probe = document.createElement('div');
      probe.className = 'motion-probe';
      probe.style.animation = 'probe 2s linear';
      document.body.append(probe);
      return getComputedStyle(probe).animationDuration;
    });
    expect(Number.parseFloat(motion)).toBeLessThanOrEqual(0.01);
    await expectNoAxeViolations(page);
  });
});
