import {
  GameStatus,
  InvitationStatus,
  type BrowserSessionDto,
  type GameDto,
  type GameId,
  type GameSnapshotDto,
  type HostOverviewDto,
  type InvitationInput,
  type InvitationPreviewDto,
  type InvitationRepresentationDto,
  type InvitationToken,
  type JoinCode,
  type OnboardingResultDto,
  type RealtimeEvent,
  type TaskEntryDto,
  type VerificationMutationResult,
} from '@human-bingo/domain';
import qrcode from 'qrcode-generator';
import { DEFAULT_TASK_BAG } from './default-task-bag.js';
import { createAlert, createButton, createSpinner, installDesignSystem } from './design-system.js';
import { browserEndpoints } from './endpoints.js';
import { createLeaderboardsSection } from './leaderboard-view.js';
import { createMemberView, type MemberViewActions, type MemberViewState } from './member-view.js';
import { RealtimeGameSocket } from './realtime-client.js';

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous' | 'error';

export interface SessionState {
  readonly status: SessionStatus;
  readonly session: BrowserSessionDto | null;
  readonly message?: string;
  readonly csrfToken?: string;
}

export type SessionFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface AppOptions {
  readonly document?: Document;
  readonly fetcher?: SessionFetcher;
  readonly initialPath?: string;
  readonly realtime?: boolean;
  readonly wsUrl?: string;
  readonly window?: Window;
}

export interface AppController {
  readonly start: () => Promise<void>;
  readonly navigate: (path: string) => void;
  readonly destroy: () => void;
}

export type AppRoute =
  | { readonly name: 'home' }
  | { readonly name: 'host-create' }
  | { readonly name: 'join' }
  | { readonly name: 'invite'; readonly token: string }
  | { readonly name: 'game'; readonly gameId: string }
  | { readonly name: 'host'; readonly gameId: string }
  | { readonly name: 'notifications'; readonly gameId: string }
  | { readonly name: 'not-found' };

type InvitationState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly preview: InvitationPreviewDto;
      readonly input: InvitationInput;
    }
  | { readonly status: 'error'; readonly message: string; readonly retryable: boolean };

interface HostView {
  readonly status: 'loading' | 'ready' | 'error';
  readonly game?: GameDto;
  readonly tasks: readonly TaskEntryDto[];
  readonly invitation?: InvitationRepresentationDto;
  readonly overview?: HostOverviewDto;
  readonly message?: string;
  /** 403 after the host-session self-heal failed: offer the reclaim form. */
  readonly needsReclaim?: boolean;
}

interface ApiErrorShape {
  readonly message: string;
  readonly code?: string;
  readonly retryable?: boolean;
}

class ApiRequestError extends Error {
  public constructor(
    message: string,
    readonly code?: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSession(value: unknown): value is BrowserSessionDto {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.expiresAt === 'string' &&
    typeof value.authorizationVersion === 'number'
  );
}

function asInvitationToken(value: string): InvitationToken {
  return value as InvitationToken;
}

function asJoinCode(value: string): JoinCode {
  return value as JoinCode;
}

function idempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID();
  return `browser-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function asJson<T>(value: unknown): T {
  return value as T;
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function requestJson<T>(
  fetcher: SessionFetcher,
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  const method = (init.method ?? 'GET').toUpperCase();
  if (activeCsrfToken !== undefined && method !== 'GET')
    headers.set('x-csrf-token', activeCsrfToken);
  const response = await fetcher(input, { ...init, credentials: 'include', headers });
  const payload = await readPayload(response);
  if (!response.ok) {
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
    const correlationId =
      isRecord(payload) && typeof payload.correlationId === 'string'
        ? payload.correlationId
        : undefined;
    const shape: ApiErrorShape =
      error === undefined
        ? { message: 'The request could not be completed.' }
        : {
            message:
              typeof error.message === 'string'
                ? error.message
                : 'The request could not be completed.',
            ...(typeof error.code === 'string' ? { code: error.code } : {}),
            ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
          };
    // Surface everything needed to pinpoint a failure: status, domain code, and the
    // correlation id to grep in `wrangler tail`. Example:
    // "The game state has changed; refresh and retry. [STALE_STATE] (ref 8f2c…)"
    const parts = [
      shape.message,
      typeof shape.code === 'string' ? `[${shape.code}]` : `[HTTP ${response.status}]`,
      ...(correlationId === undefined ? [] : [`ref ${correlationId}`]),
    ];
    throw new ApiRequestError(
      parts.filter((part) => part !== '').join(' · '),
      typeof shape.code === 'string' ? shape.code : undefined,
      shape.retryable === true,
      response.status,
    );
  }
  return asJson<T>(payload);
}

/**
 * GET loader with one automatic retry on server-side (5xx) failures. Platform
 * hiccups (Workers/D1 throttling under load, transient edge 502/503/504) surface
 * as unparseable error pages; retrying once after a short beat turns "host
 * setup unavailable" flashes into a seamless reload. Mutations are never
 * retried here because they are not all idempotent.
 */
async function requestJsonWithRetry<T>(
  fetcher: SessionFetcher,
  input: RequestInfo | URL,
): Promise<T> {
  try {
    return await requestJson<T>(fetcher, input);
  } catch (error: unknown) {
    const status = error instanceof ApiRequestError ? (error.status ?? 0) : 0;
    if (status >= 500 || status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 900));
      return await requestJson<T>(fetcher, input);
    }
    throw error;
  }
}

function invitationInputBody(input: InvitationInput): Record<string, string> {
  return 'joinCode' in input ? { joinCode: input.joinCode } : { token: input.token };
}

function inputKey(input: InvitationInput): string {
  return 'joinCode' in input ? `code:${input.joinCode}` : `token:${input.token}`;
}

function decodeRoutePart(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

let activeCsrfToken: string | undefined;

const sessionFromPayload = (payload: unknown): BrowserSessionDto | null => {
  const candidate = isRecord(payload) && 'session' in payload ? payload.session : payload;
  return isSession(candidate) ? candidate : null;
};

const csrfTokenFromPayload = (payload: unknown): string | undefined =>
  isRecord(payload) && typeof payload.csrfToken === 'string' ? payload.csrfToken : undefined;

const ensureSession = async (
  fetcher: SessionFetcher,
  gameIdHint?: string,
  roleHint?: 'host',
): Promise<SessionState> => {
  const hint = `${gameIdHint ? `gameId=${encodeURIComponent(gameIdHint)}` : ''}${roleHint ? `${gameIdHint ? '&' : ''}role=${roleHint}` : ''}`;
  try {
    const response = await fetcher(`/api/session${hint ? `?${hint}` : ''}`, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return { status: 'anonymous', session: null };
    const payload: unknown = await response.json();
    const session = sessionFromPayload(payload);
    if (session === null) return { status: 'anonymous', session: null };
    const csrfToken = csrfTokenFromPayload(payload);
    activeCsrfToken = csrfToken;
    return {
      status: 'authenticated',
      session,
      ...(csrfToken === undefined ? {} : { csrfToken }),
    };
  } catch {
    return { status: 'anonymous', session: null };
  }
};

export async function bootstrapSession(
  fetcher: SessionFetcher = fetch,
  gameIdHint?: string,
  roleHint?: 'host',
): Promise<SessionState> {
  const hint = `${gameIdHint ? `gameId=${encodeURIComponent(gameIdHint)}` : ''}${roleHint ? `${gameIdHint ? '&' : ''}role=${roleHint}` : ''}`;
  try {
    const response = await fetcher(`/api/session${hint ? `?${hint}` : ''}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (response.status === 401 || response.status === 404)
      return ensureSession(fetcher, gameIdHint, roleHint);
    if (!response.ok) {
      activeCsrfToken = undefined;
      return {
        status: 'error',
        session: null,
        message: 'We could not restore your browser session.',
      };
    }
    const payload: unknown = await response.json();
    const session = sessionFromPayload(payload);
    if (session === null) {
      activeCsrfToken = undefined;
      return { status: 'anonymous', session: null };
    }
    const csrfToken = csrfTokenFromPayload(payload);
    activeCsrfToken = csrfToken;
    return {
      status: 'authenticated',
      session,
      ...(csrfToken === undefined ? {} : { csrfToken }),
    };
  } catch {
    activeCsrfToken = undefined;
    return {
      status: 'error',
      session: null,
      message: 'Session bootstrap failed. You can still start or join a game.',
    };
  }
}

export function matchRoute(pathname: string): AppRoute {
  const path = pathname.split('?')[0]?.split('#')[0] ?? '/';
  if (path === '/') return { name: 'home' };
  if (path === '/host') return { name: 'host-create' };
  if (path === '/join') return { name: 'join' };
  const inviteMatch = /^\/invite\/([^/]+)$/.exec(path);
  if (inviteMatch?.[1]) {
    const token = decodeRoutePart(inviteMatch[1]);
    return token === null ? { name: 'not-found' } : { name: 'invite', token };
  }
  const gameMatch = /^\/game\/([^/]+)(?:\/(host|notifications))?$/.exec(path);
  if (gameMatch?.[1]) {
    const gameId = decodeRoutePart(gameMatch[1]);
    if (gameId === null) return { name: 'not-found' };
    if (gameMatch[2] === 'host') return { name: 'host', gameId };
    if (gameMatch[2] === 'notifications') return { name: 'notifications', gameId };
    return { name: 'game', gameId };
  }
  return { name: 'not-found' };
}

function link(
  document: Document,
  href: string,
  label: string,
  className?: string,
): HTMLAnchorElement {
  const element = document.createElement('a');
  element.href = href;
  element.textContent = label;
  if (className) element.className = className;
  return element;
}

function createPage(document: Document, title: string, description: string): HTMLElement {
  const page = document.createElement('section');
  page.className = 'page';
  const header = document.createElement('header');
  header.className = 'page__header';
  const heading = document.createElement('h1');
  heading.textContent = title;
  const copy = document.createElement('p');
  copy.textContent = description;
  header.append(heading, copy);
  page.append(header);
  return page;
}

interface ResumeGame {
  readonly gameId: string;
  readonly name: string;
}

const resumeKey = 'human-bingo:resume-game';

function saveResumeGame(gameId: string, name: string): void {
  try {
    localStorage.setItem(resumeKey, JSON.stringify({ gameId, name }));
  } catch {
    /* Storage may be unavailable; resuming is best-effort. */
  }
}

function readResumeGame(): ResumeGame | undefined {
  try {
    const raw = localStorage.getItem(resumeKey);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { gameId, name } = parsed as { gameId?: unknown; name?: unknown };
    if (typeof gameId !== 'string' || typeof name !== 'string') return undefined;
    return { gameId, name };
  } catch {
    return undefined;
  }
}

const hostResumeKey = 'human-bingo:host-game';

function saveHostGame(gameId: string, name: string): void {
  try {
    localStorage.setItem(hostResumeKey, JSON.stringify({ gameId, name }));
  } catch {
    /* Storage may be unavailable; resuming is best-effort. */
  }
}

function readHostGame(): ResumeGame | undefined {
  try {
    const raw = localStorage.getItem(hostResumeKey);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { gameId, name } = parsed as { gameId?: unknown; name?: unknown };
    if (typeof gameId !== 'string' || typeof name !== 'string') return undefined;
    return { gameId, name };
  } catch {
    return undefined;
  }
}

function createHomePage(document: Document, resume: ResumeGame | undefined): HTMLElement {
  const page = createPage(
    document,
    'Human Bingo',
    'Create a social bingo game, invite your group, and celebrate verified progress together.',
  );
  const hostResume = readHostGame();
  if (hostResume !== undefined) {
    const hostCard = document.createElement('div');
    hostCard.className = 'card stack';
    const heading = document.createElement('h2');
    heading.textContent = 'Resume your hosted game';
    const copy = document.createElement('p');
    copy.textContent = `You hosted ${hostResume.name}. Open the host controls to manage tasks, invitations, and the board.`;
    const actions = document.createElement('div');
    actions.className = 'cluster';
    actions.append(
      link(
        document,
        `/game/${encodeURIComponent(hostResume.gameId)}/host`,
        'Open host controls',
        'control control--primary',
      ),
      link(
        document,
        `/game/${encodeURIComponent(hostResume.gameId)}`,
        'Open as player',
        'control control--secondary',
      ),
    );
    hostCard.append(heading, copy, actions);
    page.append(hostCard);
  }
  if (resume !== undefined) {
    const resumeCard = document.createElement('div');
    resumeCard.className = 'card stack';
    const heading = document.createElement('h2');
    heading.textContent = 'Resume your game';
    const copy = document.createElement('p');
    copy.textContent = `You were last playing ${resume.name}. Reopen it to continue where you left off.`;
    const actions = document.createElement('div');
    actions.className = 'cluster';
    actions.append(
      link(
        document,
        `/game/${encodeURIComponent(resume.gameId)}`,
        'Rejoin game',
        'control control--primary',
      ),
    );
    resumeCard.append(heading, copy, actions);
    page.append(resumeCard);
  }
  const card = document.createElement('div');
  card.className = 'card stack';
  const heading = document.createElement('h2');
  heading.textContent = 'Start with an invitation';
  const copy = document.createElement('p');
  copy.textContent = 'Join a game with a six-character code or create a task bag for your group.';
  const actions = document.createElement('div');
  actions.className = 'cluster';
  actions.append(
    link(document, '/join', 'Join a game', 'control control--primary'),
    link(document, '/host', 'Host a game', 'control control--secondary'),
  );
  card.append(heading, copy, actions);
  page.append(card);
  return page;
}

function createHostCreatePage(
  document: Document,
  session: SessionState,
  fetcher: SessionFetcher,
  onCreated: (game: GameDto) => void,
): HTMLElement {
  const page = createPage(
    document,
    'Host a game',
    'Create a draft task bag, then open it when at least 25 distinct tasks are ready.',
  );
  const hostResume = readHostGame();
  if (hostResume !== undefined) {
    const resumeCard = document.createElement('div');
    resumeCard.className = 'card stack';
    const heading = document.createElement('h2');
    heading.textContent = 'Your last hosted game';
    const copy = document.createElement('p');
    copy.textContent = `You last hosted ${hostResume.name}. Jump back to its host controls or open it as a player.`;
    const actions = document.createElement('div');
    actions.className = 'cluster';
    actions.append(
      link(
        document,
        `/game/${encodeURIComponent(hostResume.gameId)}/host`,
        'Resume host controls',
        'control control--primary',
      ),
      link(
        document,
        `/game/${encodeURIComponent(hostResume.gameId)}`,
        'Open as player',
        'control control--secondary',
      ),
    );
    resumeCard.append(heading, copy, actions);
    page.append(resumeCard);
  }
  const card = document.createElement('form');
  card.className = 'card stack narrow-form';
  const label = document.createElement('label');
  label.htmlFor = 'new-game-name';
  label.textContent = 'Game name';
  const input = document.createElement('input');
  input.id = 'new-game-name';
  input.name = 'name';
  input.required = true;
  input.maxLength = 120;
  input.placeholder = 'Friday team bingo';
  const feedback = document.createElement('div');
  feedback.setAttribute('aria-live', 'polite');
  const submit = createButton(document, { label: 'Create draft', tone: 'primary', type: 'submit' });
  if (session.status !== 'authenticated') {
    feedback.append(
      createAlert(document, {
        title: 'Host session required',
        message: 'Start a browser session before creating a game.',
        tone: 'info',
      }),
    );
  }
  card.append(label, input, feedback, submit);
  const createDraft = async (): Promise<void> => {
    submit.disabled = true;
    feedback.replaceChildren(
      createAlert(document, { message: 'Creating your draft…', tone: 'info' }),
    );
    try {
      const payload = await requestJson<{ game: GameDto }>(fetcher, '/api/games', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey() },
        body: JSON.stringify({ name: input.value }),
      });
      onCreated(payload.game);
    } catch (error: unknown) {
      submit.disabled = false;
      feedback.replaceChildren(
        createAlert(document, {
          title: 'Could not create game',
          message: errorMessage(error),
          tone: 'error',
        }),
      );
      input.focus();
    }
  };
  card.addEventListener('submit', (event) => {
    event.preventDefault();
    if (session.status === 'authenticated') void createDraft();
  });
  page.append(card);
  return page;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request could not be completed.';
}

function createJoinPage(
  document: Document,
  activeInvitation: InvitationState | undefined,
  onResolve: (input: InvitationInput) => void,
  onOnboard: (input: InvitationInput, displayName: string) => void,
  onboarding?: OnboardingResultDto,
): HTMLElement {
  if (onboarding !== undefined) return createOnboardingCompletePage(document, onboarding);
  if (activeInvitation?.status === 'ready')
    return createOnboardingPage(document, activeInvitation, onOnboard);

  const page = createPage(
    document,
    'Join a game',
    'Enter the code shared by the host. Invitation resolution never creates a membership by itself.',
  );
  const card = document.createElement('form');
  card.className = 'card stack narrow-form';
  const label = document.createElement('label');
  label.htmlFor = 'join-code';
  label.textContent = 'Six-character join code';
  const input = document.createElement('input');
  input.id = 'join-code';
  input.name = 'joinCode';
  input.inputMode = 'text';
  input.autocomplete = 'off';
  input.autocapitalize = 'characters';
  input.spellcheck = false;
  input.maxLength = 6;
  input.placeholder = 'ABC123';
  input.required = true;
  input.setAttribute('aria-describedby', 'join-help join-feedback');
  const help = document.createElement('span');
  help.id = 'join-help';
  help.textContent = 'Use uppercase letters A–Z and digits 0–9.';
  help.className = 'muted';
  const feedback = document.createElement('div');
  feedback.id = 'join-feedback';
  feedback.setAttribute('aria-live', 'polite');
  if (activeInvitation?.status === 'error') {
    feedback.append(
      createAlert(document, {
        title: 'Invitation unavailable',
        message: activeInvitation.message,
        tone: 'error',
      }),
    );
    if (activeInvitation.retryable)
      feedback.append(
        createAlert(document, { message: 'You can retry the invitation check.', tone: 'info' }),
      );
  }
  const submit = createButton(document, { label: 'Continue', tone: 'primary', type: 'submit' });
  card.append(label, input, help, feedback, submit);
  card.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = input.value.trim().toUpperCase();
    input.value = code;
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      feedback.replaceChildren(
        createAlert(document, {
          title: 'Invalid join code',
          message: 'Enter exactly six uppercase letters or digits.',
          tone: 'error',
        }),
      );
      input.focus();
      return;
    }
    onResolve({ joinCode: asJoinCode(code) });
  });
  page.append(card);
  return page;
}

function createInvitePage(
  document: Document,
  token: string,
  state: InvitationState | undefined,
  onContinue: (input: InvitationInput) => void,
  onRetry: () => void,
): HTMLElement {
  const page = createPage(
    document,
    'Invitation preview',
    'Review the invitation before joining. Your participant record is created only when onboarding is completed.',
  );
  const card = document.createElement('div');
  card.className = 'card stack';
  const heading = document.createElement('h2');
  heading.textContent = 'Invitation link received';
  card.append(heading);
  if (state?.status === 'ready') {
    const preview = state.preview;
    const copy = document.createElement('p');
    copy.textContent = `${preview.gameName} is ready for onboarding.`;
    const status = document.createElement('p');
    status.className = 'invitation-status';
    status.textContent =
      preview.gameStatus === GameStatus.Closed ||
      preview.invitationStatus !== InvitationStatus.Available
        ? 'This invitation is no longer accepting participants.'
        : 'This invitation is valid. No participant record has been created.';
    card.append(copy, status);
    if (
      preview.gameStatus !== GameStatus.Closed &&
      preview.invitationStatus === InvitationStatus.Available
    ) {
      card.append(
        createButton(document, {
          label: 'Continue to onboarding',
          tone: 'primary',
          onClick: () => onContinue(state.input),
        }),
      );
    } else {
      card.append(
        createAlert(document, {
          title: 'Invitation closed',
          message: 'Ask the host for a new invitation.',
          tone: 'warning',
        }),
      );
    }
  } else if (state?.status === 'error') {
    card.append(
      createAlert(document, {
        title: 'Invitation unavailable',
        message: state.message,
        tone: 'error',
      }),
    );
    card.append(
      createButton(document, {
        label: 'Retry invitation check',
        tone: 'secondary',
        onClick: onRetry,
      }),
    );
  } else {
    card.append(
      createAlert(document, {
        message: 'Checking this invitation. No membership is created during this check.',
        tone: 'info',
      }),
    );
  }
  void token;
  page.append(card);
  return page;
}

function createOnboardingPage(
  document: Document,
  state: Extract<InvitationState, { status: 'ready' }>,
  onOnboard: (input: InvitationInput, displayName: string) => void,
): HTMLElement {
  const preview = state.preview;
  const page = createPage(
    document,
    'Join Human Bingo',
    `Complete onboarding for ${preview.gameName}.`,
  );
  const card = document.createElement('form');
  card.className = 'card stack narrow-form';
  const explanation = document.createElement('p');
  explanation.textContent =
    'The invitation has been resolved. Your participant record and Player_Code are created only when you submit this form.';
  const label = document.createElement('label');
  label.htmlFor = 'display-name';
  label.textContent = 'Display name';
  const input = document.createElement('input');
  input.id = 'display-name';
  input.name = 'displayName';
  input.maxLength = 80;
  input.required = true;
  input.setAttribute('autocomplete', 'nickname');
  input.setAttribute('aria-describedby', 'onboarding-feedback');
  const feedback = document.createElement('div');
  feedback.id = 'onboarding-feedback';
  feedback.setAttribute('aria-live', 'polite');
  const submit = createButton(document, {
    label: 'Complete onboarding',
    tone: 'primary',
    type: 'submit',
  });
  card.append(explanation, label, input, feedback, submit);
  card.addEventListener('submit', (event) => {
    event.preventDefault();
    if (input.value.trim().length === 0) {
      feedback.replaceChildren(
        createAlert(document, {
          title: 'Display name required',
          message: 'Enter a name to continue.',
          tone: 'error',
        }),
      );
      input.focus();
      return;
    }
    submit.disabled = true;
    feedback.replaceChildren(
      createAlert(document, { message: 'Completing onboarding…', tone: 'info' }),
    );
    onOnboard(state.input, input.value.trim());
  });
  page.append(card);
  return page;
}

function createOnboardingCompletePage(
  document: Document,
  result: OnboardingResultDto,
): HTMLElement {
  const page = createPage(
    document,
    result.resumed ? 'Welcome back' : 'You joined the game',
    'Your membership and randomized grid are saved for this game.',
  );
  const card = document.createElement('div');
  card.className = 'card stack';
  const heading = document.createElement('h2');
  heading.textContent = result.resumed ? 'Resume your game' : 'Onboarding complete';
  const copy = document.createElement('p');
  copy.textContent =
    'Share this Player_Code with other participants when they need to verify a square.';
  const code = document.createElement('output');
  code.className = 'player-code';
  code.setAttribute('aria-label', 'Your Player Code');
  code.textContent = result.profile.playerCode;
  const resume = link(
    document,
    `/game/${encodeURIComponent(String(result.game.id))}`,
    'Open my game',
    'control control--primary',
  );
  card.append(heading, copy, code, resume);
  page.append(card);
  return page;
}

function createLoadingPage(document: Document): HTMLElement {
  const page = createPage(
    document,
    'Loading Human Bingo',
    'Restoring your browser session before showing game-specific controls.',
  );
  page.append(createSpinner(document, 'Restoring your browser session…'));
  return page;
}

function createHostOverview(document: Document, overview: HostOverviewDto): HTMLElement {
  const section = document.createElement('section');
  section.className = 'host-overview stack';
  section.setAttribute('aria-labelledby', 'host-overview-heading');

  const heading = document.createElement('h2');
  heading.id = 'host-overview-heading';
  heading.textContent = `Game overview · ${overview.participants.length} joined`;
  section.append(heading);

  const people = document.createElement('section');
  people.className = 'card stack';
  people.setAttribute('aria-labelledby', 'joined-people-heading');
  const peopleHeading = document.createElement('h3');
  peopleHeading.id = 'joined-people-heading';
  peopleHeading.textContent = 'Joined people';
  people.append(peopleHeading);

  if (overview.participants.length === 0) {
    people.append(
      createAlert(document, {
        message: 'No one has joined yet. Share the invitation to start the game.',
        tone: 'info',
      }),
    );
  } else {
    const list = document.createElement('ol');
    list.className = 'participant-list';
    list.setAttribute('aria-label', 'Joined people and progress');
    for (const entry of overview.participants) {
      const item = document.createElement('li');
      item.className = 'participant-entry';

      const identity = document.createElement('div');
      identity.className = 'participant-entry__identity';
      const name = document.createElement('strong');
      name.textContent = entry.participant.displayName;
      const code = document.createElement('span');
      code.className = 'muted';
      code.textContent = `Player_Code: ${entry.participant.playerCode}`;
      identity.append(name, code);

      const activity = document.createElement('small');
      activity.className = 'muted participant-entry__activity';
      activity.textContent =
        entry.lastSeenAt === undefined
          ? `Joined ${new Date(String(entry.joinedAt)).toLocaleString()}`
          : `Last seen ${new Date(String(entry.lastSeenAt)).toLocaleString()}`;

      item.append(identity, activity);
      list.append(item);
    }
    people.append(list);
  }

  section.append(
    people,
    createLeaderboardsSection(document, overview.leaderboards, overview.stateVersion),
  );
  return section;
}

function createHostPage(
  document: Document,
  gameId: string,
  session: SessionState,
  view: HostView | undefined,
  onMutation: (action: string, body: Record<string, unknown>) => void,
  onLoadDefaultBag: () => void,
  onInvitation: () => void,
  onRetry: () => void,
  invitationFailed: boolean,
  onReclaim?: (name: string) => Promise<void>,
): HTMLElement {
  const page = createPage(
    document,
    'Host setup',
    'Edit the task bag, open or close the game, and share a safe invitation representation.',
  );
  if (session.status !== 'authenticated') {
    page.append(
      createAlert(document, {
        title: session.status === 'error' ? 'Session unavailable' : 'Sign in to continue',
        message: session.message ?? 'A host session is required for setup.',
        tone: session.status === 'error' ? 'warning' : 'info',
      }),
    );
    page.append(link(document, '/host', 'Start a host session', 'control control--primary'));
    return page;
  }
  if (view === undefined || (view.status === 'loading' && view.game === undefined)) {
    page.append(createSpinner(document, 'Loading the authoritative host setup…'));
    return page;
  }
  if (view.status === 'error' || view.game === undefined) {
    page.append(
      createAlert(document, {
        title: 'Host setup unavailable',
        message: view.message ?? 'We could not load this game.',
        tone: 'error',
      }),
    );
    page.append(
      createButton(document, { label: 'Retry setup', tone: 'secondary', onClick: onRetry }),
    );
    if (view.needsReclaim && onReclaim !== undefined) {
      const reclaimCard = document.createElement('form');
      reclaimCard.className = 'card stack narrow-form';
      const reclaimHeading = document.createElement('h2');
      reclaimHeading.textContent = 'Reclaim hosting';
      const reclaimHelp = document.createElement('p');
      reclaimHelp.className = 'muted';
      reclaimHelp.textContent =
        'This browser is not currently recognized as the host (a player session took over). Enter the exact game name to move hosting to this browser.';
      const reclaimLabel = document.createElement('label');
      reclaimLabel.htmlFor = 'reclaim-game-name';
      reclaimLabel.textContent = 'Exact game name';
      const reclaimInput = document.createElement('input');
      reclaimInput.id = 'reclaim-game-name';
      reclaimInput.name = 'name';
      reclaimInput.required = true;
      reclaimInput.maxLength = 120;
      reclaimInput.value = readHostGame()?.name ?? '';
      const reclaimFeedback = document.createElement('div');
      reclaimFeedback.setAttribute('aria-live', 'polite');
      const reclaimSubmit = createButton(document, {
        label: 'Reclaim hosting',
        tone: 'primary',
        type: 'submit',
      });
      reclaimCard.append(
        reclaimHeading,
        reclaimHelp,
        reclaimLabel,
        reclaimInput,
        reclaimFeedback,
        reclaimSubmit,
      );
      reclaimCard.addEventListener('submit', (event) => {
        event.preventDefault();
        const name = reclaimInput.value.trim();
        if (name.length === 0) return;
        reclaimSubmit.disabled = true;
        reclaimSubmit.classList.add('button--busy');
        reclaimFeedback.replaceChildren(
          createAlert(document, { message: 'Reclaiming hosting…', tone: 'info' }),
        );
        onReclaim(name).catch((error: unknown) => {
          reclaimSubmit.disabled = false;
          reclaimSubmit.classList.remove('button--busy');
          reclaimFeedback.replaceChildren(
            createAlert(document, {
              message: error instanceof Error ? error.message : 'Could not reclaim hosting.',
              tone: 'error',
            }),
          );
        });
      });
      page.append(reclaimCard);
    }
    return page;
  }

  const game = view.game;
  const share: HTMLElement[] = [];
  if (view.invitation !== undefined) {
    share.push(createInvitationCard(document, view.invitation, onInvitation));
  } else if (game.status === GameStatus.Active || game.status === GameStatus.InvitationAvailable) {
    const placeholder = document.createElement('section');
    placeholder.className = 'card stack';
    placeholder.append(
      createAlert(document, {
        message: invitationFailed
          ? 'The invitation could not be prepared.'
          : 'The invitation is being prepared.',
        tone: invitationFailed ? 'error' : 'info',
      }),
      createButton(document, {
        label: 'Show invitation',
        tone: 'primary',
        onClick: onInvitation,
      }),
    );
    share.push(placeholder);
  }

  // Task bag — only visible while draft, hidden once game is opened
  let taskCard: HTMLElement | null = null;
  if (game.status === GameStatus.Draft) {
    taskCard = document.createElement('div');
    taskCard.className = 'card stack';
    const taskHeading = document.createElement('h2');
    taskHeading.textContent = 'Task bag';
    const taskHelp = document.createElement('p');
    taskHelp.className = 'muted';
    taskHelp.textContent =
      'Tasks are trimmed and compared case-insensitively; duplicates and blank tasks are rejected.';
    const taskList = document.createElement('div');
    taskList.className = 'task-list';
    for (const task of view.tasks) {
      const row = document.createElement('form');
      row.className = 'task-row';
      const input = document.createElement('input');
      input.value = task.text;
      input.setAttribute('aria-label', `Task ${task.text}`);
      const save = createButton(document, {
        label: 'Save',
        tone: 'quiet',
        type: 'submit',
      });
      const remove = createButton(document, {
        label: 'Remove',
        tone: 'danger',
      });
      row.append(input, save, remove);
      row.addEventListener('submit', (event) => {
        event.preventDefault();
        onMutation('edit_task', { taskEntryId: task.id, text: input.value });
      });
      remove.addEventListener('click', () => onMutation('remove_task', { taskEntryId: task.id }));
      taskList.append(row);
    }
    const addForm = document.createElement('form');
    addForm.className = 'cluster';
    const addInput = document.createElement('input');
    addInput.placeholder = 'Add a task';
    addInput.maxLength = 240;
    addInput.setAttribute('aria-label', 'New task');
    const add = createButton(document, {
      label: 'Add task',
      tone: 'secondary',
      type: 'submit',
    });
    addForm.append(addInput, add);
    addForm.addEventListener('submit', (event) => {
      event.preventDefault();
      onMutation('add_task', { text: addInput.value });
    });
    taskCard.append(taskHeading, taskHelp, taskList, addForm);
    taskCard.append(
      createButton(document, {
        label: `Load ${DEFAULT_TASK_BAG.length} default tasks`,
        tone: 'quiet',
        onClick: onLoadDefaultBag,
      }),
    );
  }

  const actions = document.createElement('div');
  actions.className = 'card cluster';
  if (game.status === GameStatus.Draft) {
    actions.append(
      createButton(document, {
        label: 'Open invitations',
        tone: 'primary',
        disabled: game.distinctTaskCount < 25,
        onClick: () => onMutation('open', {}),
      }),
    );
    if (game.distinctTaskCount < 25)
      actions.append(
        createAlert(document, {
          message: `Add ${25 - game.distinctTaskCount} more distinct task${25 - game.distinctTaskCount === 1 ? '' : 's'} to open this game.`,
          tone: 'warning',
        }),
      );
  } else if (game.status !== GameStatus.Closed) {
    actions.append(
      createButton(document, {
        label: 'Close game',
        tone: 'danger',
        onClick: () => onMutation('close', {}),
      }),
    );
  }
  if (game.status === GameStatus.Closed) {
    actions.append(
      createAlert(document, {
        message: 'Closed games are read-only. Existing participants and results are preserved.',
        tone: 'warning',
      }),
    );
    actions.append(link(document, '/host', 'Host a new game', 'control control--primary'));
  }

  page.append(...share);
  if (view.overview !== undefined) page.append(createHostOverview(document, view.overview));
  if (taskCard) page.append(taskCard);
  page.append(actions);
  if (view.message !== undefined)
    page.append(
      createAlert(document, {
        message: view.message,
        tone: 'error',
      }),
    );
  void gameId;
  return page;
}

const toBase64 = (encoded: string): string =>
  encoded
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(encoded.length / 4) * 4, '=');

/** Decodes the canonical link carried by the `hbqr1.` payload. */
const decodeQrPayload = (payload: string): string => {
  if (!payload.startsWith('hbqr1.')) throw new Error('Invalid Human Bingo QR payload');
  const encoded = payload.slice('hbqr1.'.length);
  if (encoded.length === 0 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('Invalid Human Bingo QR payload');
  }
  const decoded = atob(toBase64(encoded));
  const parsed = new URL(decoded);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Invalid Human Bingo invitation link');
  }
  return parsed.toString();
};

const createQrSvg = (payload: string): string => {
  const link = decodeQrPayload(payload);
  const qr = qrcode(0, 'L');
  qr.addData(link);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
};

function createInvitationCard(
  document: Document,
  invitation: InvitationRepresentationDto,
  _onRefresh?: () => void,
): HTMLElement {
  void _onRefresh;
  const card = document.createElement('section');
  card.className = 'card stack invitation-card invitation-share';
  const heading = document.createElement('h2');
  heading.textContent = 'Invite players';
  const grid = document.createElement('div');
  grid.className = 'invitation-share__grid';
  const details = document.createElement('div');
  details.className = 'invitation-share__details stack';
  const codeLabel = document.createElement('span');
  codeLabel.className = 'muted';
  codeLabel.textContent = 'Join_Code';
  const code = document.createElement('output');
  code.className = 'join-code';
  code.setAttribute('aria-label', 'Join Code');
  code.textContent = invitation.joinCode;
  const joinAt = document.createElement('p');
  joinAt.className = 'join-at';
  let joinAtHost = '';
  try {
    joinAtHost = new URL(invitation.canonicalLink).host;
  } catch {
    joinAtHost = '';
  }
  joinAt.textContent = `Join at ${joinAtHost}`;
  const feedback = document.createElement('div');
  feedback.setAttribute('aria-live', 'polite');
  const presentation = document.createElement('div');
  presentation.className = 'invitation-share__qr';
  const qr = document.createElement('div');
  qr.className = 'qr-presentation';
  qr.setAttribute('role', 'img');
  qr.setAttribute('aria-label', 'QR code for the invitation link');
  qr.dataset.qrPayload = invitation.qrPayload;
  try {
    qr.innerHTML = createQrSvg(invitation.qrPayload);
  } catch {
    qr.textContent = invitation.canonicalLink;
  }
  presentation.append(qr);
  details.append(codeLabel, code, joinAt);
  grid.append(details, presentation);
  card.append(heading, grid, feedback);
  return card;
}

function renderErrorBoundary(document: Document, error: unknown): HTMLElement {
  const page = createPage(
    document,
    'Something went wrong',
    'The app could not render this view safely. Your saved game data remains on the server.',
  );
  page.append(
    createAlert(document, {
      title: 'Application error',
      message: error instanceof Error ? error.message : 'Unknown application error',
      tone: 'error',
    }),
  );
  page.append(link(document, '/', 'Return home', 'control control--primary'));
  return page;
}

function createAppShell(
  document: Document,
  session: SessionState,
): { main: HTMLElement; shell: HTMLElement } {
  const shell = document.createElement('div');
  shell.className = 'app-shell';
  shell.append(link(document, '#main-content', 'Skip to main content', 'skip-link'));
  const header = document.createElement('header');
  header.className = 'app-header';
  const headerInner = document.createElement('div');
  headerInner.className = 'app-header__inner';
  // Brand: SCD lockup that returns to main site + Human Bingo wordmark
  const brandGroup = document.createElement('div');
  brandGroup.className = 'brand-group';
  const scdLink = document.createElement('a');
  scdLink.href = 'https://scd.awsugcebu.org/';
  scdLink.className = 'brand brand--scd';
  scdLink.setAttribute('aria-label', 'Back to AWS Student Community Day Cebu — scd.awsugcebu.org');
  scdLink.setAttribute('data-external', 'true');
  const scdImg = document.createElement('img');
  scdImg.src = '/pfp.webp';
  scdImg.alt = '';
  scdImg.width = 28;
  scdImg.height = 28;
  scdImg.decoding = 'async';
  scdImg.loading = 'eager';
  const scdText = document.createElement('span');
  scdText.textContent = 'SCD Cebu';
  scdLink.append(scdImg, scdText);
  // External navigation must bypass BingoApp's proxy — handle via real window
  scdLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.location.href = 'https://scd.awsugcebu.org/';
  });
  const divider = document.createElement('span');
  divider.className = 'brand-divider';
  divider.setAttribute('aria-hidden', 'true');
  divider.textContent = '·';
  const bingoLink = link(document, '/', 'Human Bingo', 'brand brand--bingo');
  bingoLink.setAttribute('aria-current', 'page');
  brandGroup.append(scdLink, divider, bingoLink);
  headerInner.append(brandGroup);
  const nav = document.createElement('nav');
  nav.className = 'app-nav';
  nav.setAttribute('aria-label', 'Primary navigation');
  nav.append(link(document, '/join', 'Join'));
  if (session.status === 'authenticated') nav.append(link(document, '/', 'Home'));
  const backLink = document.createElement('a');
  backLink.href = 'https://scd.awsugcebu.org/';
  backLink.className = 'brand-back';
  backLink.textContent = 'SCD Home →';
  backLink.setAttribute('aria-label', 'Back to main SCD website');
  backLink.setAttribute('data-external', 'true');
  backLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.location.href = 'https://scd.awsugcebu.org/';
  });
  nav.append(backLink);
  headerInner.append(nav);
  header.append(headerInner);
  shell.append(header);
  const main = document.createElement('main');
  main.id = 'main-content';
  main.className = 'app-main';
  main.tabIndex = -1;
  shell.append(main);
  const footer = document.createElement('footer');
  footer.className = 'app-footer';
  footer.textContent = 'Human Bingo · verified together';
  shell.append(footer);
  return { main, shell };
}

export function createApp(root: HTMLElement, options: AppOptions = {}): AppController {
  const document = options.document ?? root.ownerDocument;
  if (!document) throw new Error('An app root must belong to a document.');
  const browserWindow =
    options.window ?? document.defaultView ?? (typeof window !== 'undefined' ? window : undefined);
  if (!browserWindow) throw new Error('An app root must belong to a browser window.');
  const fetcher = options.fetcher ?? fetch;
  let currentPath =
    options.initialPath ??
    `${browserWindow.location.pathname}${browserWindow.location.search}${browserWindow.location.hash}`;
  let session: SessionState = { status: 'loading', session: null };
  let destroyed = false;
  const invitations = new Map<string, InvitationState>();
  const hosts = new Map<string, HostView>();
  const snapshots = new Map<string, GameSnapshotDto>();
  const memberStates = new Map<string, MemberViewState>();
  const loading = new Set<string>();
  let liveGameKey: string | undefined;
  let liveRefresh: (() => Promise<void>) | undefined;
  let liveSocket: RealtimeGameSocket | undefined;
  let livePollTimer: ReturnType<typeof setInterval> | undefined;
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  const queuedRefreshes = new Set<string>();
  let onboarding: OnboardingResultDto | undefined;
  let joinInvitationKey: string | undefined;
  let lastRouteName: AppRoute['name'] | undefined;

  const rerender = (): void => {
    if (destroyed || renderTimer !== undefined) return;
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      if (!destroyed) render();
    }, 16);
  };
  const stopRealtime = (): void => {
    liveSocket?.close();
    liveSocket = undefined;
    liveRefresh = undefined;
    liveGameKey = undefined;
    if (livePollTimer !== undefined) clearInterval(livePollTimer);
    livePollTimer = undefined;
  };
  const syncRealtimeForRoute = (route: AppRoute): void => {
    const gameRoute =
      route.name === 'host' || route.name === 'game' || route.name === 'notifications'
        ? route
        : undefined;
    if (session.status !== 'authenticated' || gameRoute === undefined) {
      stopRealtime();
      return;
    }
    const key = `${gameRoute.name}:${gameRoute.gameId}`;
    if (key === liveGameKey) return;
    stopRealtime();
    const refresh =
      gameRoute.name === 'host'
        ? () => loadHostOverview(gameRoute.gameId)
        : () => loadSnapshot(gameRoute.gameId);
    liveGameKey = key;
    liveRefresh = refresh;
    const realtimeAvailable = typeof WebSocket === 'function';
    if (options.realtime !== false && realtimeAvailable) {
      const wsUrl = options.wsUrl ?? browserEndpoints().wsUrl;
      const initialStateVersion =
        gameRoute.name === 'host'
          ? (hosts.get(gameRoute.gameId)?.overview?.stateVersion ??
            hosts.get(gameRoute.gameId)?.game?.stateVersion)
          : snapshots.get(gameRoute.gameId)?.stateVersion;
      const socket = new RealtimeGameSocket({
        wsUrl,
        gameId: gameRoute.gameId as GameId,
        ...(initialStateVersion === undefined ? {} : { initialStateVersion }),
        onEvent: (event: RealtimeEvent) => {
          const currentVersion =
            gameRoute.name === 'host'
              ? (hosts.get(gameRoute.gameId)?.overview?.stateVersion ??
                hosts.get(gameRoute.gameId)?.game?.stateVersion)
              : snapshots.get(gameRoute.gameId)?.stateVersion;
          const eventVersion =
            event.type === 'game.patch' ? event.stateVersion : event.expectedStateVersion;
          const isRetentionMiss =
            event.type === 'snapshot_required' && event.reason === 'retention_miss';
          if (currentVersion !== undefined && eventVersion <= currentVersion && !isRetentionMiss) {
            liveSocket?.acknowledgeStateVersion(currentVersion);
            return;
          }
          void refresh();
        },
      });
      liveSocket = socket;
      socket.connect();
    }
    livePollTimer = setInterval(() => {
      if (document.hidden || liveSocket?.isHealthy) return;
      void refresh();
    }, 30_000);
  };
  const onVisibilityChange = (): void => {
    if (!document.hidden) {
      liveSocket?.connect();
      void liveRefresh?.();
    }
  };
  const resolveInvitation = async (
    input: InvitationInput,
    activateForJoin = false,
  ): Promise<void> => {
    const key = inputKey(input);
    if (activateForJoin) joinInvitationKey = key;
    if (loading.has(`invitation:${key}`)) return;
    invitations.set(key, { status: 'loading' });
    loading.add(`invitation:${key}`);
    rerender();
    try {
      const encoded =
        'joinCode' in input
          ? encodeURIComponent(String(input.joinCode))
          : encodeURIComponent(String(input.token));
      const payload = await requestJson<{ preview: InvitationPreviewDto }>(
        fetcher,
        `/api/invitations/${encoded}`,
      );
      invitations.set(key, { status: 'ready', preview: payload.preview, input });
    } catch (error: unknown) {
      invitations.set(key, {
        status: 'error',
        message: errorMessage(error),
        retryable: error instanceof ApiRequestError ? error.retryable : true,
      });
    } finally {
      loading.delete(`invitation:${key}`);
      rerender();
    }
  };
  const loadHost = async (gameId: string, hasRetried = false): Promise<void> => {
    const refreshKey = `host:${gameId}`;
    if (loading.has(refreshKey)) {
      queuedRefreshes.add(refreshKey);
      return;
    }
    const previous = hosts.get(gameId);
    loading.add(refreshKey);
    hosts.set(gameId, {
      status: 'loading',
      tasks: previous?.tasks ?? [],
      ...(previous?.game === undefined ? {} : { game: previous.game }),
      ...(previous?.invitation === undefined ? {} : { invitation: previous.invitation }),
      ...(previous?.overview === undefined ? {} : { overview: previous.overview }),
    });
    if (previous?.game === undefined) rerender();
    try {
      const payload = await requestJsonWithRetry<{
        game: GameDto;
        tasks: readonly TaskEntryDto[];
        invitation?: InvitationRepresentationDto;
        overview?: HostOverviewDto;
      }>(fetcher, `/api/games/${encodeURIComponent(gameId)}/host`);
      hosts.set(gameId, {
        status: 'ready',
        game: payload.game,
        tasks: payload.tasks ?? [],
        ...(payload.invitation === undefined
          ? previous?.invitation === undefined
            ? {}
            : { invitation: previous.invitation }
          : { invitation: payload.invitation }),
        ...(payload.overview === undefined
          ? previous?.overview === undefined
            ? {}
            : { overview: previous.overview }
          : { overview: payload.overview }),
      });
      const stateVersion = payload.overview?.stateVersion ?? payload.game.stateVersion;
      if (liveGameKey === `host:${gameId}`) liveSocket?.acknowledgeStateVersion(stateVersion);
    } catch (error: unknown) {
      const status = error instanceof ApiRequestError ? (error.status ?? 0) : 0;
      // Self-heal: a player onboarding in this browser replaced the shared session
      // with a membership identity, so the proper host got 403 here. Re-bootstrap
      // with role=host — the worker switches back to the per-game host credential.
      if ((status === 401 || status === 403) && !hasRetried) {
        loading.delete(refreshKey);
        const next = await bootstrapSession(fetcher, gameId, 'host');
        session = next;
        if (next.status === 'authenticated') {
          await loadHost(gameId, true);
          return;
        }
      }
      const needsReclaim = status === 403;
      if (previous?.game !== undefined) {
        hosts.set(gameId, {
          ...previous,
          status: 'ready',
          needsReclaim,
          message: `Could not load the host setup. ${errorMessage(error)}`,
        });
      } else {
        hosts.set(gameId, {
          status: 'error',
          tasks: [],
          needsReclaim,
          message: `Could not load the host setup. ${errorMessage(error)}`,
        });
      }
    } finally {
      loading.delete(refreshKey);
      rerender();
      if (queuedRefreshes.delete(refreshKey)) void loadHost(gameId);
      if (queuedRefreshes.delete(`host-overview:${gameId}`)) void loadHostOverview(gameId);
    }
  };
  const reclaimHosting = async (gameId: string, name: string): Promise<void> => {
    await requestJson<{ game: GameDto }>(
      fetcher,
      `/api/games/${encodeURIComponent(gameId)}/reclaim`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey() },
        body: JSON.stringify({ name }),
      },
    );
    const current = hosts.get(gameId);
    if (current !== undefined) {
      const rest = { ...current };
      delete rest.needsReclaim;
      delete rest.message;
      hosts.set(gameId, rest);
    }
    await loadHost(gameId);
  };
  const loadSnapshot = async (gameId: string, hasRetried = false): Promise<void> => {
    const refreshKey = `snapshot:${gameId}`;
    if (loading.has(refreshKey)) {
      queuedRefreshes.add(refreshKey);
      return;
    }
    loading.add(refreshKey);
    try {
      const payload = await requestJsonWithRetry<{ snapshot: GameSnapshotDto }>(
        fetcher,
        `/api/games/${encodeURIComponent(gameId)}/snapshot`,
      );
      const memberState = memberStates.get(gameId);
      const mine = memberState?.participantId;
      if (
        mine === undefined ||
        String(payload.snapshot.membership.participantId) === String(mine)
      ) {
        snapshots.set(gameId, payload.snapshot);
        saveResumeGame(gameId, payload.snapshot.game.name);
        if (memberState !== undefined) {
          const rest = { ...memberState };
          delete rest.snapshotError;
          memberStates.set(gameId, {
            ...rest,
            ...(mine === undefined
              ? { participantId: payload.snapshot.membership.participantId }
              : {}),
          });
        }
      } else if (memberState !== undefined) {
        const rest = { ...memberState };
        delete rest.snapshotError;
        memberStates.set(gameId, {
          ...rest,
          identityChangedTo: payload.snapshot.profile.displayName,
        });
      }
      if (liveGameKey === `game:${gameId}` || liveGameKey === `notifications:${gameId}`)
        liveSocket?.acknowledgeStateVersion(payload.snapshot.stateVersion);
    } catch (error: unknown) {
      // Self-heal instead of spinning forever on "Loading the authoritative game snapshot…":
      // - 401/403: the session expired or was rebound; re-bootstrap (the worker
      //   transparently rebinds the membership from the resume cookie) and retry once.
      // - 429/5xx: throttled or transient platform error; back off and retry once.
      const status = error instanceof ApiRequestError ? (error.status ?? 0) : 0;
      const recoverable = status === 401 || status === 403 || status === 429 || status >= 500;
      if (recoverable && !hasRetried) {
        loading.delete(refreshKey);
        if (status === 401 || status === 403) {
          const next = await bootstrapSession(fetcher, gameId);
          session = next;
          if (next.status === 'authenticated') {
            await loadSnapshot(gameId, true);
            return;
          }
        } else {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          await loadSnapshot(gameId, true);
          return;
        }
      }
      const current = memberStates.get(gameId) ?? { selectedSquareIndex: null, playerCode: '' };
      memberStates.set(gameId, { ...current, snapshotError: errorMessage(error) });
    } finally {
      loading.delete(refreshKey);
      rerender();
      if (queuedRefreshes.delete(refreshKey)) void loadSnapshot(gameId);
    }
  };
  const loadHostOverview = async (gameId: string): Promise<void> => {
    const refreshKey = `host-overview:${gameId}`;
    const current = hosts.get(gameId);
    if (current?.game === undefined) {
      await loadHost(gameId);
      return;
    }
    if (loading.has(`host:${gameId}`)) {
      queuedRefreshes.add(refreshKey);
      return;
    }
    if (loading.has(refreshKey)) {
      queuedRefreshes.add(refreshKey);
      return;
    }
    loading.add(refreshKey);
    try {
      const payload = await requestJsonWithRetry<{ overview: HostOverviewDto }>(
        fetcher,
        `/api/games/${encodeURIComponent(gameId)}/host-overview`,
      );
      const latest = hosts.get(gameId) ?? current;
      hosts.set(gameId, { ...latest, status: 'ready', overview: payload.overview });
      if (liveGameKey === `host:${gameId}`)
        liveSocket?.acknowledgeStateVersion(payload.overview.stateVersion);
    } catch (error: unknown) {
      const latest = hosts.get(gameId) ?? current;
      hosts.set(gameId, {
        ...latest,
        status: 'ready',
        message: `Could not refresh the live overview. ${errorMessage(error)}`,
      });
    } finally {
      loading.delete(refreshKey);
      rerender();
      if (queuedRefreshes.delete(refreshKey)) void loadHostOverview(gameId);
    }
  };
  const memberActions = (gameId: string): MemberViewActions => ({
    retryLoad: () => {
      const current = memberStates.get(gameId);
      if (current !== undefined) {
        const rest = { ...current };
        delete rest.snapshotError;
        memberStates.set(gameId, rest);
      }
      snapshots.delete(gameId);
      rerender();
      void loadSnapshot(gameId);
    },
    requestVerification: async (squareIndex, identifiedPlayerCode): Promise<void> => {
      const snapshot = snapshots.get(gameId);
      if (snapshot === undefined) throw new Error('The game snapshot is not ready.');
      const payload = await requestJson<VerificationMutationResult | null>(
        fetcher,
        `/api/games/${encodeURIComponent(gameId)}/verification-requests`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey() },
          body: JSON.stringify({
            gridId: snapshot.grid.id,
            squareIndex,
            identifiedPlayerCode,
            knownStateVersion: snapshot.stateVersion,
          }),
        },
      );
      if (payload !== null) {
        const squares = snapshot.grid.squares.map((square) =>
          square.squareIndex === squareIndex ? payload.square : square,
        );
        snapshots.set(gameId, {
          ...snapshot,
          grid: { ...snapshot.grid, squares },
          verificationRequests: [...snapshot.verificationRequests, payload.request],
          notifications: [...snapshot.notifications, ...payload.notifications],
        });
      }
      rerender();
      await loadSnapshot(gameId);
    },
    respondToVerification: async (requestId, decision): Promise<void> => {
      const snapshot = snapshots.get(gameId);
      if (snapshot === undefined) throw new Error('The game snapshot is not ready.');
      await requestJson(
        fetcher,
        `/api/verification-requests/${encodeURIComponent(String(requestId))}/${decision}`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey() },
          body: JSON.stringify({
            gameId,
            knownStateVersion: snapshot.stateVersion,
          }),
        },
      );
      await loadSnapshot(gameId);
    },
    cancelVerification: async (requestId): Promise<void> => {
      const snapshot = snapshots.get(gameId);
      if (snapshot === undefined) throw new Error('The game snapshot is not ready.');
      await requestJson(
        fetcher,
        `/api/verification-requests/${encodeURIComponent(String(requestId))}/cancel`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey() },
          body: JSON.stringify({
            gameId,
            knownStateVersion: snapshot.stateVersion,
          }),
        },
      );
      await loadSnapshot(gameId);
    },
  });
  const hostMutation = async (
    gameId: string,
    action: string,
    body: Record<string, unknown>,
    hasRetried = false,
  ): Promise<void> => {
    const view = hosts.get(gameId);
    if (view?.game === undefined) return;
    try {
      const payload = await requestJson<{ game: GameDto; tasks: readonly TaskEntryDto[] }>(
        fetcher,
        `/api/games/${encodeURIComponent(gameId)}`,
        {
          method: 'PATCH',
          headers: {
            'Idempotency-Key': idempotencyKey(),
            'If-Match': String(view.game.stateVersion),
          },
          body: JSON.stringify({ ...body, action, knownStateVersion: view.game.stateVersion }),
        },
      );
      hosts.set(gameId, {
        status: 'ready',
        game: payload.game,
        tasks: payload.tasks ?? [],
        ...(view.invitation === undefined ? {} : { invitation: view.invitation }),
        ...(view.overview === undefined
          ? {}
          : { overview: { ...view.overview, stateVersion: payload.game.stateVersion } }),
      });
      if (action === 'open') await createInvitation(gameId);
      rerender();
    } catch (error: unknown) {
      const msg = errorMessage(error);
      const isStale = error instanceof ApiRequestError && error.code === 'STALE_STATE';
      if (isStale && !hasRetried) {
        // Another player joined and bumped stateVersion. Refresh the authoritative view
        // and retry the same mutation once with the fresh version — the host should not
        // have to notice and manually retry (this surfaced as "Could not update game").
        await loadHost(gameId);
        const refreshed = hosts.get(gameId);
        if (
          refreshed?.game !== undefined &&
          refreshed.game.stateVersion !== view.game.stateVersion
        ) {
          await hostMutation(gameId, action, body, true);
          return;
        }
      }
      hosts.set(gameId, { ...view, status: 'ready', message: `Could not update the game. ${msg}` });
      rerender();
    }
  };
  const fillingBags = new Set<string>();
  const loadDefaultBag = async (gameId: string): Promise<void> => {
    if (fillingBags.has(gameId)) return;
    fillingBags.add(gameId);
    try {
      await hostMutation(gameId, 'add_tasks', { texts: DEFAULT_TASK_BAG });
    } finally {
      fillingBags.delete(gameId);
    }
  };
  const invitationRequests = new Set<string>();
  const invitationFailures = new Set<string>();
  const createInvitation = async (gameId: string): Promise<void> => {
    if (invitationRequests.has(gameId)) return;
    const view = hosts.get(gameId);
    if (view?.game === undefined) return;
    invitationRequests.add(gameId);
    try {
      const payload = await requestJson<{ invitation: InvitationRepresentationDto }>(
        fetcher,
        `/api/games/${encodeURIComponent(gameId)}/invitation`,
        { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey() }, body: '{}' },
      );
      invitationFailures.delete(gameId);
      const { message: _cleared, ...rest } = view;
      void _cleared;
      hosts.set(gameId, { ...rest, invitation: payload.invitation });
    } catch (error: unknown) {
      invitationFailures.add(gameId);
      hosts.set(gameId, { ...view, status: 'ready', message: errorMessage(error) });
    } finally {
      invitationRequests.delete(gameId);
    }
    rerender();
  };
  const onboard = async (input: InvitationInput, displayName: string): Promise<void> => {
    const state = invitations.get(inputKey(input));
    if (state?.status !== 'ready') return;
    try {
      const payload = await requestJson<{ onboarding: OnboardingResultDto }>(
        fetcher,
        `/api/games/${encodeURIComponent(String(state.preview.gameId))}/onboarding`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey() },
          body: JSON.stringify({ ...invitationInputBody(input), displayName }),
        },
      );
      onboarding = payload.onboarding;
      const gameId = String(state.preview.gameId);
      saveResumeGame(gameId, payload.onboarding.game.name);
      const memberState = memberStates.get(gameId) ?? { selectedSquareIndex: null, playerCode: '' };
      memberStates.set(gameId, {
        ...memberState,
        participantId: payload.onboarding.profile.participantId,
      });
      session = await bootstrapSession(fetcher, gameId);
      rerender();
    } catch (error: unknown) {
      invitations.set(inputKey(input), {
        ...state,
        status: 'error',
        message: errorMessage(error),
        retryable: error instanceof ApiRequestError ? error.retryable : true,
      });
      rerender();
    }
  };
  const render = (): void => {
    if (destroyed) return;
    try {
      const { main, shell } = createAppShell(document, session);
      const route = matchRoute(currentPath);
      if (session.status === 'loading') main.append(createLoadingPage(document));
      else {
        if (session.message)
          main.append(createAlert(document, { message: session.message, tone: 'warning' }));
        main.append(renderRoute(route));
      }
      root.replaceChildren(shell);
      syncRealtimeForRoute(route);
      if (route.name === 'invite') {
        const input: InvitationInput = { token: asInvitationToken(route.token) };
        if (!invitations.has(inputKey(input))) void resolveInvitation(input);
      }
      if (route.name === 'host' && session.status === 'authenticated' && !hosts.has(route.gameId))
        void loadHost(route.gameId);
      if (route.name === 'host') {
        const hostView = hosts.get(route.gameId);
        const hostGame = hostView?.game;
        if (
          hostView?.status === 'ready' &&
          hostView.invitation === undefined &&
          !invitationFailures.has(route.gameId) &&
          hostGame !== undefined &&
          (hostGame.status === GameStatus.Active ||
            hostGame.status === GameStatus.InvitationAvailable)
        ) {
          void createInvitation(route.gameId);
        }
      }
      if (
        (route.name === 'game' || route.name === 'notifications') &&
        session.status === 'authenticated' &&
        !snapshots.has(route.gameId)
      )
        void loadSnapshot(route.gameId);
    } catch (error: unknown) {
      root.replaceChildren(renderErrorBoundary(document, error));
    }
  };
  const renderRoute = (route: AppRoute): HTMLElement => {
    const routeChangedToJoin = route.name === 'join' && lastRouteName !== 'join';
    lastRouteName = route.name;
    if (route.name === 'home') return createHomePage(document, readResumeGame());
    if (route.name === 'host-create')
      return createHostCreatePage(document, session, fetcher, (game) => {
        hosts.set(String(game.id), { status: 'ready', game, tasks: [] });
        saveHostGame(String(game.id), game.name);
        controller.navigate(`/game/${encodeURIComponent(String(game.id))}/host`);
      });
    if (route.name === 'join') {
      const query = new URL(currentPath, browserWindow.location.origin).searchParams;
      const token = query.get('token');
      if (token !== null) {
        joinInvitationKey = inputKey({ token: asInvitationToken(token) });
        if (!invitations.has(joinInvitationKey))
          void resolveInvitation({ token: asInvitationToken(token) }, true);
      } else if (routeChangedToJoin) {
        // Arrived at /join from another route (e.g. clicking Join from another game's
        // context) — clear stale join state so the fresh code form shows. This must run
        // ONLY on the route transition: clearing on every render reset the form right
        // after the user submitted a code (the loading rerender wiped joinInvitationKey),
        // which made "entering the join code do nothing".
        onboarding = undefined;
        joinInvitationKey = undefined;
      }
      const state =
        joinInvitationKey === undefined ? undefined : invitations.get(joinInvitationKey);
      // If state is for a previous game's onboarding that already completed, don't show it on fresh /join
      const freshState =
        state?.status === 'ready' &&
        onboarding !== undefined &&
        onboarding.game.id !== state.preview.gameId
          ? undefined
          : state;
      return createJoinPage(
        document,
        freshState,
        (input) => void resolveInvitation(input, true),
        (input, displayName) => {
          void onboard(input, displayName);
        },
        onboarding,
      );
    }
    if (route.name === 'invite') {
      const input: InvitationInput = { token: asInvitationToken(route.token) };
      return createInvitePage(
        document,
        route.token,
        invitations.get(inputKey(input)),
        () => {
          joinInvitationKey = inputKey(input);
          controller.navigate(`/join?token=${encodeURIComponent(route.token)}`);
        },
        () => {
          invitations.delete(inputKey(input));
          void resolveInvitation(input);
        },
      );
    }
    if (route.name === 'host')
      return createHostPage(
        document,
        route.gameId,
        session,
        hosts.get(route.gameId),
        (action, body) => void hostMutation(route.gameId, action, body),
        () => void loadDefaultBag(route.gameId),
        () => void createInvitation(route.gameId),
        () => {
          hosts.delete(route.gameId);
          void loadHost(route.gameId);
        },
        invitationFailures.has(route.gameId),
        (name) => reclaimHosting(route.gameId, name),
      );
    if (route.name === 'game' || route.name === 'notifications') {
      const state = memberStates.get(route.gameId) ?? { selectedSquareIndex: null, playerCode: '' };
      memberStates.set(route.gameId, state);
      return createMemberView(
        document,
        route.name,
        route.gameId,
        session,
        snapshots.get(route.gameId),
        state,
        memberActions(route.gameId),
      );
    }
    const page = createPage(document, 'Page not found', 'That Human Bingo route does not exist.');
    page.append(link(document, '/', 'Return home', 'control control--primary'));
    return page;
  };
  const onPopState = (): void => {
    currentPath = `${browserWindow.location.pathname}${browserWindow.location.search}${browserWindow.location.hash}`;
    rerender();
  };
  const onClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a');
    if (!anchor || anchor.origin !== browserWindow.location.origin || anchor.target === '_blank')
      return;
    const href = new URL(anchor.href);
    if (!href.pathname.startsWith('/')) return;
    event.preventDefault();
    controller.navigate(`${href.pathname}${href.search}${href.hash}`);
  };
  const controller: AppController = {
    start: async (): Promise<void> => {
      render();
      session = await bootstrapSession(fetcher);
      render();
    },
    navigate: (path: string): void => {
      const url = new URL(path, browserWindow.location.origin);
      currentPath = `${url.pathname}${url.search}${url.hash}`;
      browserWindow.history.pushState({}, '', currentPath);
      render();
    },
    destroy: (): void => {
      destroyed = true;
      if (renderTimer !== undefined) clearTimeout(renderTimer);
      renderTimer = undefined;
      stopRealtime();
      browserWindow.removeEventListener('popstate', onPopState);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      root.removeEventListener('click', onClick);
    },
  };
  browserWindow.addEventListener('popstate', onPopState);
  document.addEventListener('visibilitychange', onVisibilityChange);
  root.addEventListener('click', onClick);
  return controller;
}

export function renderApplicationError(root: HTMLElement, error: unknown): void {
  installDesignSystem(root.ownerDocument);
  root.replaceChildren(renderErrorBoundary(root.ownerDocument, error));
}

export async function mountApp(root?: HTMLElement): Promise<AppController> {
  const appRoot = root ?? (typeof document !== 'undefined' ? document.getElementById('app') : null);
  if (!appRoot) throw new Error('Missing #app root.');
  installDesignSystem(appRoot.ownerDocument);
  const controller = createApp(appRoot);
  await controller.start();
  return controller;
}
