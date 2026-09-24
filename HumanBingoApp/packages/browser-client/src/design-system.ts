import type { SquareStatus } from '@human-bingo/domain';

export type ButtonTone = 'primary' | 'secondary' | 'quiet' | 'danger';
export type AlertTone = 'info' | 'success' | 'warning' | 'error';

export interface ButtonOptions {
  readonly label: string;
  readonly tone?: ButtonTone;
  readonly type?: 'button' | 'submit' | 'reset';
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly ariaLabel?: string;
  readonly onClick?: (event: MouseEvent) => void;
}

export interface AlertOptions {
  readonly title?: string;
  readonly message: string;
  readonly tone?: AlertTone;
  readonly live?: boolean;
}

export interface DialogOptions {
  readonly title: string;
  readonly content: Node | string;
  readonly closeLabel?: string;
}

export interface StatusToken {
  readonly label: string;
  readonly icon: string;
  readonly pattern: string;
  readonly className: string;
}

let nextDialogId = 0;

const statusTokens: Record<SquareStatus, StatusToken> = {
  unverified: {
    label: 'Unverified',
    icon: '○',
    pattern: 'solid',
    className: 'status--unverified',
  },
  pending: {
    label: 'Pending',
    icon: '◌',
    pattern: 'striped',
    className: 'status--pending',
  },
  rejected: {
    label: 'Rejected',
    icon: '×',
    pattern: 'crosshatch',
    className: 'status--rejected',
  },
  verified: {
    label: 'Verified',
    icon: '✓',
    pattern: 'dotted',
    className: 'status--verified',
  },
};

export function getStatusToken(status: SquareStatus): StatusToken {
  return statusTokens[status];
}

export function createStatusToken(document: Document, status: SquareStatus): HTMLSpanElement {
  const token = getStatusToken(status);
  const element = document.createElement('span');
  element.className = `status ${token.className}`;
  element.dataset.status = status;
  element.dataset.pattern = token.pattern;
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = token.icon;
  const label = document.createElement('span');
  label.textContent = token.label;
  element.append(icon, label);
  return element;
}

export function createButton(document: Document, options: ButtonOptions): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = options.type ?? 'button';
  element.className = `control control--${options.tone ?? 'secondary'}`;
  element.textContent = options.label;
  element.disabled = options.disabled ?? false;
  if (options.busy) {
    element.classList.add('button--busy');
    element.setAttribute('aria-busy', 'true');
  }
  if (options.ariaLabel) {
    element.setAttribute('aria-label', options.ariaLabel);
  }
  if (options.onClick) {
    element.addEventListener('click', options.onClick);
  }
  return element;
}

export function createAlert(document: Document, options: AlertOptions): HTMLElement {
  const element = document.createElement('div');
  element.className = `alert alert--${options.tone ?? 'info'}`;
  element.setAttribute('role', options.tone === 'error' ? 'alert' : 'status');
  if (options.live !== false) {
    element.setAttribute('aria-live', options.tone === 'error' ? 'assertive' : 'polite');
  }

  if (options.title) {
    const title = document.createElement('strong');
    title.textContent = options.title;
    element.append(title);
  }
  const message = document.createElement('span');
  message.textContent = options.message;
  element.append(message);
  return element;
}

export function createSpinner(document: Document, label: string): HTMLElement {
  const element = document.createElement('p');
  element.className = 'spinner-row';
  element.setAttribute('role', 'status');
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.textContent = label;
  element.append(spinner, text);
  return element;
}

export function createDialog(document: Document, options: DialogOptions): HTMLDialogElement {
  const element = document.createElement('dialog');
  const titleId = `dialog-title-${nextDialogId++}`;
  element.className = 'dialog';
  element.setAttribute('aria-labelledby', titleId);

  const heading = document.createElement('h2');
  heading.id = titleId;
  heading.textContent = options.title;
  element.append(heading);

  const content = document.createElement('div');
  content.className = 'dialog__content';
  if (typeof options.content === 'string') {
    content.textContent = options.content;
  } else {
    content.append(options.content);
  }
  element.append(content);

  const actions = document.createElement('div');
  actions.className = 'dialog__actions';
  actions.append(
    createButton(document, {
      label: options.closeLabel ?? 'Close',
      tone: 'secondary',
      onClick: () => element.close(),
    }),
  );
  element.append(actions);
  return element;
}

export function designSystemCss(): string {
  return `
:root {
  color-scheme: light;
  --color-ink: #172033;
  --color-muted: #536176;
  --color-surface: #ffffff;
  --color-surface-muted: #f3f6fa;
  --color-border: #c9d2df;
  --color-primary: #2056b3;
  --color-primary-strong: #153d82;
  --color-danger: #a52424;
  --color-success: #176b42;
  --color-warning: #755000;
  --focus-ring: #f2a900;
  --radius: 0.75rem;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.5;
  font-weight: 400;
  color: var(--color-ink);
  background: var(--color-surface-muted);
}

*, *::before, *::after { box-sizing: border-box; }
html { min-width: 320px; background: var(--color-surface-muted); -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { margin: 0; min-width: 320px; min-height: 100vh; }
button, input, textarea, select { font: inherit; }
a { color: var(--color-primary-strong); }
:focus-visible { outline: 3px solid var(--focus-ring); outline-offset: 3px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.responsive-grid { display: grid; gap: clamp(1rem, 2vw, 1.5rem); grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); }
.layout { display: grid; gap: clamp(1rem, 3vw, 2rem); min-width: 0; }

.app-shell { min-height: 100vh; display: flex; flex-direction: column; }
.skip-link { position: absolute; z-index: 10; left: 0.75rem; top: 0.75rem; padding: 0.6rem 0.8rem; background: var(--color-ink); color: #fff; transform: translateY(-200%); }
.skip-link:focus { transform: translateY(0); }
.app-header { background: var(--color-ink); color: #fff; }
.app-header__inner, .app-main, .app-footer { width: min(100% - 2rem, 72rem); margin-inline: auto; padding-inline: max(0rem, env(safe-area-inset-left)) max(0rem, env(safe-area-inset-right)); }
.app-header__inner { min-height: 4rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.brand { color: #fff; text-decoration: none; font-size: 1.125rem; font-weight: 750; }
.app-nav { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.app-nav a { color: #fff; }
.app-main { flex: 1; min-width: 0; width: min(100% - 2rem, 72rem); padding-block: 2rem 3rem; }
.app-footer { padding-block: 1.5rem; color: var(--color-muted); font-size: 0.875rem; }
.page { display: grid; gap: 1.25rem; min-width: 0; }
.page__header { display: grid; gap: 0.5rem; max-width: 48rem; }
.page__header h1, .page__header h2 { margin: 0; line-height: 1.15; }
.page__header p { margin: 0; color: var(--color-muted); }
.card { min-width: 0; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius); padding: clamp(1rem, 3vw, 1.5rem); box-shadow: 0 0.25rem 1rem rgb(23 32 51 / 6%); }
.stack { display: grid; gap: 1rem; }
.narrow-form { width: min(100%, 36rem); }
.cluster { display: flex; align-items: center; flex-wrap: wrap; gap: 0.75rem; }
.task-list { display: grid; gap: 0.65rem; }
.task-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 0.5rem; }
.task-row input { min-width: 0; }
.muted { color: var(--color-muted); }
.game-status { margin: 0; font-weight: 700; }
.invitation-status { margin: 0; font-weight: 700; }
.join-code, .player-code { display: block; width: fit-content; padding: 0.6rem 0.85rem; border: 2px dashed var(--color-primary); border-radius: 0.55rem; font-size: clamp(1.4rem, 6vw, 2rem); font-weight: 800; letter-spacing: 0.15em; overflow-wrap: anywhere; }
.invitation-share { border-color: var(--color-primary); }
.invitation-share .join-code { font-size: clamp(2.25rem, 9vw, 3.5rem); padding: 0.9rem 1.4rem; }
.invitation-share__grid { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: clamp(1rem, 3vw, 2rem); align-items: start; }
.invitation-share__details { gap: 0.65rem; }
.invitation-share__qr { display: grid; justify-items: center; gap: 0.75rem; text-align: center; }
.invitation-share__qr .qr-presentation { width: min(11rem, 100%); }
.join-at { margin: 0; color: var(--color-muted); font-size: 1.05rem; font-weight: 700; letter-spacing: 0.05em; }
@media (max-width: 40rem) {
  .invitation-share__grid { grid-template-columns: 1fr; }
}
.qr-presentation { display: grid; place-items: center; width: min(12rem, 100%); aspect-ratio: 1; padding: 1rem; border: 0.7rem solid #172033; background: #fff; }
.qr-presentation svg { display: block; width: 100%; height: 100%; overflow-wrap: anywhere; }
input, textarea { min-width: 0; border: 1px solid var(--color-border); border-radius: 0.45rem; padding: 0.65rem 0.75rem; background: var(--color-surface); color: var(--color-ink); }
input:disabled { background: var(--color-surface-muted); }
.bingo-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); grid-auto-rows: 1fr; gap: clamp(0.25rem, 1.5vw, 0.6rem); width: 100%; min-width: 0; }
.member-layout { display: grid; gap: clamp(1rem, 3vw, 2rem); min-width: 0; }
.bingo-square { display: grid; grid-template-rows: 1fr; align-content: stretch; min-width: 0; min-height: clamp(6.5rem, 19vw, 9rem); height: 100%; padding: clamp(0.4rem, 1.5vw, 0.8rem); border: 2px solid var(--color-border); border-radius: 0.55rem; background: var(--color-surface); color: var(--color-ink); text-align: left; cursor: pointer; touch-action: manipulation; }
.bingo-square:hover:not(:disabled), .bingo-square--selected { border-color: var(--color-primary); box-shadow: 0 0 0 2px rgb(32 86 179 / 20%); }
.bingo-square { transition: border-color 150ms ease-out, box-shadow 150ms ease-out, transform 150ms ease-out; }
.bingo-square:active:not(:disabled) { transform: scale(0.98); }
.bingo-square:disabled { cursor: not-allowed; opacity: 0.78; }
.bingo-square.square--pending { background: #fff8e6; border-color: #e1bd62; }
.bingo-square.square--rejected { background: #fff0f0; border-color: #d99494; }
.bingo-square.square--verified { background: #ecf9f1; border-color: #8ac5a4; }
.square-task { min-width: 0; overflow-wrap: anywhere; font-size: clamp(0.75rem, 2.8vw, 1rem); line-height: 1.15; font-weight: 700; }
.grid-legend { margin: 0; text-wrap: pretty; }
.verification-dialog { display: grid; gap: 0.9rem; }
.verification-square { display: grid; gap: 0.5rem; padding: 1rem; border: 2px solid var(--color-border); border-radius: 0.55rem; background: var(--color-surface-muted); }
.verification-square.square--pending { background: #fff8e6; border-color: #e1bd62; }
.verification-square.square--rejected { background: #fff0f0; border-color: #d99494; }
.verification-square.square--verified { background: #ecf9f1; border-color: #8ac5a4; }
.verification-square__task { font-size: clamp(1.1rem, 5vw, 1.5rem); font-weight: 800; line-height: 1.2; overflow-wrap: anywhere; }
.verification-square__status { margin: 0; }
.notification-inbox { min-width: 0; }
.notification-card { display: grid; gap: 0.5rem; padding: 0.9rem; border: 1px solid var(--color-border); border-radius: 0.55rem; }
.notification-card h3, .notification-card p { margin: 0; }
.notification-card--pending { border-left: 0.35rem solid var(--color-warning); }
.notification-card--resolved { border-left: 0.35rem solid var(--color-muted); }
.notification-status { color: var(--color-muted); font-weight: 700; }
.verification-history-entry { display: grid; gap: 0.5rem; min-width: 0; padding: 0.9rem; border: 1px solid var(--color-border); border-radius: 0.55rem; }
.verification-history-entry h3, .verification-history-entry p { margin: 0; overflow-wrap: anywhere; }
.verification-history-entry--pending { border-left: 0.35rem solid var(--color-warning); }
.verification-history-entry--confirmed { border-left: 0.35rem solid var(--color-success); }
.verification-history-entry--rejected { border-left: 0.35rem solid var(--color-danger); }
.leaderboards { min-width: 0; }
.leaderboards > h2 { margin: 0; }
.leaderboard { min-width: 0; }
.leaderboard h2 { margin: 0; }
.leaderboard-total, .leaderboard-update { margin: 0; }
.leaderboard-total { font-weight: 750; }
.leaderboard-list { display: grid; gap: 0.65rem; padding: 0; margin: 0; list-style: none; }
.leaderboard-entry { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-width: 0; padding: 0.85rem; border: 1px solid var(--color-border); border-radius: 0.55rem; }
.leaderboard-entry__identity, .leaderboard-entry__result { display: grid; gap: 0.15rem; min-width: 0; }
.leaderboard-entry__identity strong, .leaderboard-entry__identity span, .leaderboard-entry__result time { overflow-wrap: anywhere; }
.leaderboard-entry__result { flex: 0 1 auto; text-align: right; }
.leaderboard-entry__result strong { font-size: 1.35rem; line-height: 1; }
.leaderboard-entry__result time { color: var(--color-muted); font-size: 0.8rem; }
.host-overview { min-width: 0; }
.participant-list { display: grid; gap: 0.65rem; padding: 0; margin: 0; list-style: none; }
.participant-entry { display: grid; grid-template-columns: minmax(0, 1fr) minmax(8rem, 0.8fr); align-items: center; gap: 0.85rem; min-width: 0; padding: 0.85rem; border: 1px solid var(--color-border); border-radius: 0.55rem; background: var(--color-surface-muted); }
.participant-entry__identity { display: grid; gap: 0.15rem; min-width: 0; }
.participant-entry__identity strong, .participant-entry__identity span, .participant-entry__activity { overflow-wrap: anywhere; }
.participant-entry__activity { text-align: right; }
.state-announcement { min-height: 1.5rem; color: var(--color-muted); font-weight: 650; }
.control { border: 2px solid transparent; border-radius: 0.55rem; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; min-height: 2.75rem; padding: 0.55rem 0.9rem; font-weight: 700; text-decoration: none; }
.control:disabled { cursor: not-allowed; opacity: 0.55; }
.button--busy::after { content: ""; display: inline-block; width: 1rem; height: 1rem; margin-left: 0.5rem; border: 0.2rem solid currentColor; border-top-color: transparent; border-radius: 50%; animation: spinner-spin 700ms linear infinite; vertical-align: -0.2em; }
.spinner-row { display: inline-flex; align-items: center; gap: 0.6rem; margin: 0; color: var(--color-muted); font-weight: 650; }
.spinner { width: 1.1rem; height: 1.1rem; flex: none; border: 0.2rem solid var(--color-border); border-top-color: var(--color-primary); border-radius: 50%; animation: spinner-spin 700ms linear infinite; }
@keyframes spinner-spin { to { transform: rotate(360deg); } }
.control--primary { background: var(--color-primary); color: #fff; }
.control--primary:hover:not(:disabled) { background: var(--color-primary-strong); }
.control--secondary { background: var(--color-surface); color: var(--color-primary-strong); border-color: var(--color-primary); }
.control--quiet { background: transparent; color: var(--color-primary-strong); }
.control--danger { background: var(--color-danger); color: #fff; }
.alert { display: grid; gap: 0.2rem; padding: 0.8rem 1rem; border: 1px solid; border-radius: 0.55rem; }
.alert--info { color: var(--color-primary-strong); background: #edf4ff; border-color: #8eafe4; }
.alert--success { color: var(--color-success); background: #ecf9f1; border-color: #8ac5a4; }
.alert--warning { color: var(--color-warning); background: #fff8e6; border-color: #e1bd62; }
.alert--error { color: var(--color-danger); background: #fff0f0; border-color: #d99494; }
.dialog { position: fixed; inset: 0; margin: auto; width: min(calc(100% - 2rem), 34rem); max-width: min(calc(100% - 2rem), 34rem); height: fit-content; max-height: calc(100dvh - 2rem); overflow: auto; border: 0; border-radius: var(--radius); padding: 1.5rem; color: var(--color-ink); box-shadow: 0 1rem 3rem rgb(23 32 51 / 25%); }
.dialog::backdrop { background: rgb(23 32 51 / 60%); }
.dialog h2 { margin-top: 0; }
.dialog__actions { display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 1.25rem; }
.status { display: inline-flex; align-items: center; gap: 0.35rem; border-radius: 0.4rem; padding: 0.2rem 0.45rem; font-size: 0.875rem; font-weight: 700; }
.status > :first-child { display: inline-grid; min-width: 1rem; place-items: center; }
.status::before { content: ""; width: 0.7rem; height: 0.7rem; border: 1px solid currentColor; }
.status--unverified { color: var(--color-muted); background: #eef1f5; }
.status--pending { color: var(--color-warning); background: repeating-linear-gradient(135deg, #fff8e6, #fff8e6 4px, #f6e5af 4px, #f6e5af 7px); }
.status--pending::before { border-radius: 50%; }
.status--rejected { color: var(--color-danger); background: repeating-linear-gradient(45deg, #fff0f0, #fff0f0 4px, #f1c0c0 4px, #f1c0c0 7px); }
.status--rejected::before { background: currentColor; }
.status--verified { color: var(--color-success); background: #ecf9f1; }
.status--verified::before { background: currentColor; border-radius: 50%; }

@media (max-width: 899px) {
  .member-layout { grid-template-columns: 1fr; }
  .bingo-grid { grid-auto-rows: minmax(40px, auto); gap: clamp(0.15rem, 1.2vw, 0.3rem); }
  .bingo-square { min-height: 40px; height: auto; aspect-ratio: 1; padding: clamp(0.15rem, 1.2vw, 0.35rem); border-width: 1px; }
  .square-task { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; font-size: clamp(0.7rem, 2.6vw, 0.9rem); line-height: 1.2; }
  .participant-entry { grid-template-columns: minmax(0, 1fr) auto; gap: 0.55rem 0.75rem; }
  .participant-entry__activity { grid-column: 1 / -1; text-align: left; }
}
@media (max-width: 480px) {
  .app-main { padding-block: 1.5rem 2.5rem; }
  .card { padding: 1rem; }
  .task-row { grid-template-columns: 1fr 1fr; row-gap: 0.6rem; }
  .task-row input { grid-column: 1 / -1; }
  .leaderboard-entry { align-items: flex-start; flex-wrap: wrap; gap: 0.5rem; }
  .leaderboard-entry__result { text-align: left; }
  .participant-entry { grid-template-columns: 1fr; }
  .participant-entry__activity { text-align: left; }
  .control { padding: 0.55rem 0.8rem; }
  .cluster { row-gap: 0.6rem; }
  .app-header__inner { min-height: 3.5rem; }
  .brand { font-size: 1rem; }
}
@media (min-width: 900px) {
  .app-header__inner, .app-main, .app-footer { width: min(100% - 3rem, 72rem); }
  .app-main { padding-block: 3rem 4rem; }
  .member-layout { grid-template-columns: minmax(0, 1.25fr) minmax(18rem, 0.75fr); align-items: start; }
  .leaderboards { grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: start; }
  .leaderboards > h2, .leaderboards > p { grid-column: 1 / -1; }
}
@media (min-width: 1024px) {
  .app-main { padding-block-start: 4rem; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
`;
}

export function installDesignSystem(document: Document): void {
  if (document.getElementById('human-bingo-design-system')) return;
  const style = document.createElement('style');
  style.id = 'human-bingo-design-system';
  style.textContent = designSystemCss();
  document.head.append(style);
}
