import {
  GameStatus,
  NotificationStatus,
  SquareStatus,
  VerificationRequestStatus,
  type GameSnapshotDto,
  type VerificationRequestDto,
} from '@human-bingo/domain';
import { createAlert, createButton, createDialog, createSpinner } from './design-system.js';
import { createLeaderboardsSection } from './leaderboard-view.js';

export interface MemberSessionView {
  readonly status: 'loading' | 'authenticated' | 'anonymous' | 'error';
  readonly message?: string;
}

export interface MemberViewState {
  selectedSquareIndex: number | null;
  playerCode: string;
  feedback?: { readonly message: string; readonly tone: 'info' | 'success' | 'warning' | 'error' };
  busyAction?: string;
  focusTarget?: string;
  /** The participant this tab is bound to for the game, captured on first adoption. */
  participantId?: string;
  /** Another player's display name observed when the shared browser session was rebound. */
  identityChangedTo?: string;
  /** Set when the authoritative snapshot could not be loaded; drives the retry UI. */
  snapshotError?: string;
}

export interface MemberViewActions {
  readonly requestVerification: (
    squareIndex: number,
    identifiedPlayerCode: string,
  ) => Promise<void>;
  readonly respondToVerification: (
    requestId: VerificationRequestDto['id'],
    decision: 'confirm' | 'reject',
  ) => Promise<void>;
  /** Reloads the authoritative snapshot after a load failure. */
  readonly retryLoad?: () => void;
  /** Withdraws the caller's pending verification request for this grid. */
  readonly cancelVerification?: (requestId: VerificationRequestDto['id']) => Promise<void>;
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

function activeRequestForSquare(
  snapshot: GameSnapshotDto,
  squareIndex: number,
): VerificationRequestDto | undefined {
  return snapshot.verificationRequests.find(
    (request) =>
      request.gridId === snapshot.grid.id &&
      request.squareIndex === squareIndex &&
      request.status === VerificationRequestStatus.Pending,
  );
}

function notificationPendingCount(snapshot: GameSnapshotDto): number {
  return snapshot.notifications.filter(
    (notification) => notification.status === NotificationStatus.Pending,
  ).length;
}

function createLeaderboards(document: Document, snapshot: GameSnapshotDto): HTMLElement {
  return createLeaderboardsSection(document, snapshot.leaderboards, snapshot.stateVersion);
}

function requestStatusLabel(request: VerificationRequestDto | undefined): string {
  if (request === undefined) return 'Recorded status unavailable';
  if (request.status === VerificationRequestStatus.Pending) return 'Pending';
  if (request.status === VerificationRequestStatus.Confirmed) return 'Confirmed';
  return 'Rejected';
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

function focusAfterRender(document: Document, state: MemberViewState): void {
  if (state.focusTarget === undefined) return;
  queueMicrotask(() => document.getElementById(state.focusTarget ?? '')?.focus());
}

function notificationCard(
  document: Document,
  snapshot: GameSnapshotDto,
  notification: GameSnapshotDto['notifications'][number],
  state: MemberViewState,
  actions: MemberViewActions,
  announce: (message: string) => void,
): HTMLElement {
  const card = document.createElement('article');
  card.className = `notification-card notification-card--${notification.status}`;
  card.dataset.notificationId = String(notification.id);
  const heading = document.createElement('h3');
  heading.textContent =
    notification.status === NotificationStatus.Pending
      ? 'Verification request'
      : 'Resolved verification request';
  const request = snapshot.verificationRequests.find(
    (candidate) => String(candidate.id) === String(notification.verificationRequestId),
  );
  const details = document.createElement('p');
  details.textContent = `${notification.requestingParticipant.displayName} says they completed row ${request === undefined ? '?' : Math.floor(request.squareIndex / 5) + 1}, column ${request === undefined ? '?' : (request.squareIndex % 5) + 1}: “${notification.taskText}”`;
  const status = document.createElement('p');
  status.className = 'notification-status';
  status.textContent =
    notification.status === NotificationStatus.Pending
      ? snapshot.game.status === GameStatus.Closed
        ? 'Preserved historical request. Status: Pending. Responses are disabled because the game is closed.'
        : 'Awaiting your response. Status: Pending.'
      : `Resolved verification request. Status: ${requestStatusLabel(request)}${request?.resolvedAt === undefined ? '' : ` at ${new Date(String(request.resolvedAt)).toLocaleString()}`}.`;
  card.append(heading, details, status);

  if (
    notification.status === NotificationStatus.Pending &&
    snapshot.game.status !== GameStatus.Closed
  ) {
    const actionsRow = document.createElement('div');
    actionsRow.className = 'cluster';
    const requestId = String(notification.verificationRequestId);
    const busy = state.busyAction === requestId;
    const respond = (decision: 'confirm' | 'reject', label: string): void => {
      state.busyAction = requestId;
      state.focusTarget = `${decision}-${requestId}`;
      announce(`${label}ing verification request…`);
      for (const button of actionsRow.querySelectorAll('button')) {
        button.disabled = true;
        button.classList.add('button--busy');
      }
      void actions
        .respondToVerification(notification.verificationRequestId, decision)
        .then(() =>
          announce(`Verification request ${decision === 'confirm' ? 'confirmed' : 'rejected'}.`),
        )
        .catch((error: unknown) => {
          delete state.busyAction;
          announce(error instanceof Error ? error.message : 'The response could not be completed.');
        });
    };
    actionsRow.append(
      createButton(document, {
        label: busy ? 'Working…' : 'Confirm',
        tone: 'primary',
        disabled: busy,
        ariaLabel: `Confirm verification request from ${notification.requestingParticipant.displayName}`,
        onClick: () => respond('confirm', 'Confirm'),
      }),
      createButton(document, {
        label: busy ? 'Working…' : 'Reject',
        tone: 'danger',
        disabled: busy,
        ariaLabel: `Reject verification request from ${notification.requestingParticipant.displayName}`,
        onClick: () => respond('reject', 'Reject'),
      }),
    );
    const buttons = actionsRow.querySelectorAll('button');
    const confirmButton = buttons.item(0);
    const rejectButton = buttons.item(1);
    if (confirmButton) confirmButton.id = `confirm-${requestId}`;
    if (rejectButton) rejectButton.id = `reject-${requestId}`;
    card.append(actionsRow);
  }
  return card;
}

function createNotifications(
  document: Document,
  snapshot: GameSnapshotDto,
  state: MemberViewState,
  actions: MemberViewActions,
  announce: (message: string) => void,
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'card stack notification-inbox';
  section.setAttribute('aria-labelledby', 'notification-heading');
  const heading = document.createElement('h2');
  heading.id = 'notification-heading';
  heading.textContent = `Verification inbox (${notificationPendingCount(snapshot)} pending)`;
  section.append(heading);
  const pending = snapshot.notifications.filter(
    (notification) => notification.status === NotificationStatus.Pending,
  );
  const resolved = snapshot.notifications.filter(
    (notification) => notification.status === NotificationStatus.Resolved,
  );
  if (pending.length === 0) {
    section.append(
      createAlert(document, { message: 'No pending verification requests.', tone: 'info' }),
    );
  } else {
    const pendingGroup = document.createElement('div');
    pendingGroup.className = 'stack';
    pendingGroup.setAttribute('aria-label', 'Pending verification requests');
    for (const notification of pending)
      pendingGroup.append(
        notificationCard(document, snapshot, notification, state, actions, announce),
      );
    section.append(pendingGroup);
  }
  if (resolved.length > 0) {
    const historyHeading = document.createElement('h3');
    historyHeading.textContent = 'Request history';
    const history = document.createElement('div');
    history.className = 'stack';
    for (const notification of resolved)
      history.append(notificationCard(document, snapshot, notification, state, actions, announce));
    section.append(historyHeading, history);
  }
  return section;
}

function createVerificationHistory(document: Document, snapshot: GameSnapshotDto): HTMLElement {
  const section = document.createElement('section');
  section.className = 'card stack verification-history';
  section.setAttribute('aria-labelledby', 'verification-history-heading');
  const heading = document.createElement('h2');
  heading.id = 'verification-history-heading';
  heading.textContent = 'Verification history';
  section.append(heading);
  const requests = [...snapshot.verificationRequests].sort(
    (left, right) =>
      new Date(String(right.createdAt)).getTime() - new Date(String(left.createdAt)).getTime(),
  );
  if (requests.length === 0) {
    section.append(
      createAlert(document, {
        message: 'No verification requests have been recorded for this game.',
        tone: 'info',
      }),
    );
    return section;
  }
  const history = document.createElement('div');
  history.className = 'stack';
  for (const request of requests) {
    const card = document.createElement('article');
    card.className = `verification-history-entry verification-history-entry--${request.status}`;
    card.dataset.requestId = String(request.id);
    const title = document.createElement('h3');
    title.textContent = `Row ${Math.floor(request.squareIndex / 5) + 1}, column ${(request.squareIndex % 5) + 1}: ${request.taskText}`;
    const participants = document.createElement('p');
    participants.textContent = `${request.requestingParticipant.displayName} requested confirmation from ${request.identifiedParticipant.displayName}.`;
    const status = document.createElement('p');
    status.className = 'notification-status';
    status.textContent = `Status: ${requestStatusLabel(request)}${request.resolvedAt === undefined ? '' : ` at ${new Date(String(request.resolvedAt)).toLocaleString()}`}.`;
    card.append(title, participants, status);
    history.append(card);
  }
  section.append(history);
  return section;
}

export function createMemberView(
  document: Document,
  routeName: 'game' | 'notifications',
  gameId: string,
  session: MemberSessionView,
  snapshot: GameSnapshotDto | undefined,
  state: MemberViewState,
  actions: MemberViewActions,
): HTMLElement {
  const page = createPage(
    document,
    routeName === 'notifications' ? 'Notifications' : 'Your game',
    snapshot === undefined
      ? `Game ${gameId} is ready for the synchronized game view.`
      : `Live verified progress for ${snapshot.game.name}.`,
  );
  if (session.status !== 'authenticated') {
    page.append(
      createAlert(document, {
        title: session.status === 'error' ? 'Session unavailable' : 'Sign in to continue',
        message:
          session.message ??
          'Resume access is required to view this game. Return to Join to start onboarding.',
        tone: session.status === 'error' ? 'warning' : 'info',
      }),
    );
    return page;
  }
  if (snapshot === undefined) {
    if (state.snapshotError !== undefined) {
      // Failure state with a way forward — never an infinite spinner.
      const errorHeading = document.createElement('h2');
      errorHeading.textContent = 'We could not load your game';
      const notParticipant = /not a participant/i.test(state.snapshotError);
      page.append(errorHeading);
      page.append(
        createAlert(document, {
          title: notParticipant ? 'You have not joined this game yet' : 'Snapshot unavailable',
          message: notParticipant
            ? `${state.snapshotError} Rejoin with your invite code to get your grid.`
            : `${state.snapshotError} This is usually temporary.`,
          tone: 'error',
        }),
      );
      const actionsRow = document.createElement('div');
      actionsRow.className = 'cluster';
      actionsRow.append(
        createButton(document, {
          label: 'Retry',
          tone: 'primary',
          onClick: () => actions.retryLoad?.(),
        }),
        link(document, '/', 'Back to home', 'control control--secondary'),
      );
      if (notParticipant)
        actionsRow.append(
          link(document, '/join', 'Join with a code', 'control control--secondary'),
        );
      page.append(actionsRow);
      return page;
    }
    const loadingHeading = document.createElement('h2');
    loadingHeading.textContent = 'Synchronized game view';
    page.append(loadingHeading);
    page.append(createSpinner(document, 'Loading the authoritative game snapshot…'));
    return page;
  }

  const announcement = document.createElement('div');
  announcement.className = 'state-announcement';
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', 'polite');
  announcement.textContent = state.feedback?.message ?? 'Game state is synchronized.';
  const announce = (message: string): void => {
    state.feedback = { message, tone: 'info' };
    announcement.textContent = message;
  };
  page.append(announcement);

  const summary = document.createElement('section');
  summary.className = 'card stack game-summary';
  const summaryHeading = document.createElement('h2');
  summaryHeading.textContent = `Welcome back, ${snapshot.profile.displayName}`;
  const code = document.createElement('output');
  code.className = 'player-code';
  code.setAttribute('aria-label', 'Your Player Code');
  code.textContent = snapshot.profile.playerCode;
  summary.append(summaryHeading, code);
  page.append(summary);
  if (state.identityChangedTo !== undefined) {
    page.append(
      createAlert(document, {
        title: 'Another player joined in this browser',
        message: `This browser is now signed in as ${state.identityChangedTo}. Your view as ${snapshot.profile.displayName} is preserved here. Open the invite link in a separate browser or private window to keep playing as ${snapshot.profile.displayName}.`,
        tone: 'warning',
      }),
    );
  }
  if (snapshot.game.status === GameStatus.Closed) {
    page.append(
      createAlert(document, {
        title: 'Closed game — read-only results',
        message:
          'This game is closed. The final grid statuses, verification request history, and all three leaderboards are preserved. New requests and responses are disabled.',
        tone: 'warning',
      }),
    );
  }

  if (routeName === 'notifications') {
    page.append(
      createNotifications(document, snapshot, state, actions, announce),
      createVerificationHistory(document, snapshot),
    );
    focusAfterRender(document, state);
    return page;
  }

  const layout = document.createElement('div');
  layout.className = 'member-layout';
  const gridCard = document.createElement('section');
  gridCard.className = 'card stack';
  gridCard.setAttribute('aria-labelledby', 'grid-heading');
  const gridHeading = document.createElement('h2');
  gridHeading.id = 'grid-heading';
  gridHeading.textContent = 'Your 5×5 grid';
  const gridHelp = document.createElement('p');
  gridHelp.className = 'muted';
  gridHelp.textContent =
    'Select an unverified or rejected square to request confirmation from another participant.';
  const gridLegend = document.createElement('p');
  gridLegend.className = 'muted grid-legend';
  gridLegend.textContent = 'Status: ○ Unverified · ◌ Pending · × Rejected · ✓ Verified';
  const gridWrap = document.createElement('div');
  gridWrap.className = 'bingo-grid-wrap';
  gridWrap.setAttribute('aria-label', 'Bingo grid scroll container');
  const grid = document.createElement('div');
  grid.className = 'bingo-grid';
  grid.setAttribute('role', 'grid');
  grid.setAttribute('aria-label', 'Human Bingo task grid');
  const squares = [...snapshot.grid.squares].sort(
    (left, right) => left.squareIndex - right.squareIndex,
  );
  const squareButtons = new Map<number, HTMLButtonElement>();
  const dialogContent = document.createElement('div');
  dialogContent.className = 'verification-dialog stack';
  const verificationDialog = createDialog(document, {
    title: 'Verify a square',
    content: dialogContent,
    closeLabel: 'Done',
  });
  verificationDialog.addEventListener('click', (event) => {
    if (event.target === verificationDialog) verificationDialog.close();
  });
  verificationDialog.addEventListener('close', () => {
    state.selectedSquareIndex = null;
    for (const other of squareButtons.values()) other.classList.remove('bingo-square--selected');
    const focusTarget = `square-button-${lastSelectedSquareIndex}`;
    queueMicrotask(() => document.getElementById(focusTarget)?.focus());
    announce('Closed the verification form.');
  });

  let lastSelectedSquareIndex = -1;
  const renderVerificationDialog = (): void => {
    dialogContent.replaceChildren();
    const selected =
      state.selectedSquareIndex === null
        ? undefined
        : squares.find((square) => square.squareIndex === state.selectedSquareIndex);
    if (selected === undefined) return;
    lastSelectedSquareIndex = selected.squareIndex;
    const display = document.createElement('div');
    display.className = `verification-square square--${selected.status}`;
    const task = document.createElement('span');
    task.className = 'verification-square__task';
    task.textContent = selected.taskText;
    const statusLine = document.createElement('span');
    statusLine.className = 'muted verification-square__status';
    statusLine.textContent = `Status: ${createStatusText(selected.status)}. Row ${selected.row}, column ${selected.column}.`;
    display.append(task, statusLine);
    dialogContent.append(display);
    const currentRequest = activeRequestForSquare(snapshot, selected.squareIndex);
    if (currentRequest !== undefined || selected.status === SquareStatus.Pending) {
      dialogContent.append(
        createAlert(document, {
          message:
            currentRequest === undefined
              ? 'This square is pending verification.'
              : `Waiting for ${currentRequest.identifiedParticipant.displayName} to respond.`,
          tone: 'warning',
        }),
      );
      // The requester can withdraw a pending request instead of being stuck
      // waiting: the square returns to unverified and can be re-requested
      // with another participant's Player_Code.
      const mineToCancel =
        currentRequest !== undefined &&
        currentRequest.status === VerificationRequestStatus.Pending &&
        String(currentRequest.requestingParticipant.participantId) ===
          String(snapshot.profile.participantId) &&
        actions.cancelVerification !== undefined;
      if (mineToCancel) {
        const cancelForm = document.createElement('form');
        cancelForm.className = 'stack';
        const cancelFeedback = document.createElement('div');
        cancelFeedback.setAttribute('aria-live', 'polite');
        const cancel = createButton(document, {
          label: 'Cancel request',
          tone: 'danger',
          type: 'submit',
        });
        cancelForm.append(cancel, cancelFeedback);
        cancelForm.addEventListener('submit', (event) => {
          event.preventDefault();
          cancel.disabled = true;
          cancel.classList.add('button--busy');
          cancelFeedback.replaceChildren(
            createAlert(document, { message: 'Cancelling request…', tone: 'info' }),
          );
          actions.cancelVerification!(currentRequest.id)
            .then(() => {
              announce('Verification request cancelled. You can request another participant.');
            })
            .catch((error: unknown) => {
              cancel.disabled = false;
              cancel.classList.remove('button--busy');
              cancelFeedback.replaceChildren(
                createAlert(document, {
                  message:
                    error instanceof Error ? error.message : 'The request could not be cancelled.',
                  tone: 'error',
                }),
              );
            });
        });
        dialogContent.append(cancelForm);
      }
    } else if (
      selected.status === SquareStatus.Verified ||
      snapshot.game.status === GameStatus.Closed
    ) {
      dialogContent.append(
        createAlert(document, {
          message:
            snapshot.game.status === GameStatus.Closed
              ? 'Closed games are read-only.'
              : 'This square is already verified.',
          tone: 'success',
        }),
      );
    } else {
      const form = document.createElement('form');
      form.className = 'stack';
      const label = document.createElement('label');
      label.htmlFor = 'verification-player-code';
      label.textContent = 'Participant Player_Code';
      const input = document.createElement('input');
      input.id = 'verification-player-code';
      input.name = 'identifiedPlayerCode';
      input.value = state.playerCode;
      input.inputMode = 'text';
      input.autocomplete = 'off';
      input.autocapitalize = 'characters';
      input.spellcheck = false;
      input.maxLength = 32;
      input.setAttribute('aria-describedby', 'verification-feedback');
      input.addEventListener('input', () => {
        state.playerCode = input.value;
        state.focusTarget = input.id;
      });
      const feedback = document.createElement('div');
      feedback.id = 'verification-feedback';
      feedback.setAttribute('aria-live', 'polite');
      if (state.feedback !== undefined)
        feedback.append(
          createAlert(document, {
            message: state.feedback.message,
            tone: state.feedback.tone,
          }),
        );
      const submit = createButton(document, {
        label: 'Request verification',
        tone: 'primary',
        type: 'submit',
        disabled: false,
      });
      form.append(label, input, feedback, submit);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const playerCode = input.value.trim().toUpperCase();
        input.value = playerCode;
        state.playerCode = playerCode;
        state.focusTarget = input.id;
        if (!/^[A-Z0-9]{1,32}$/.test(playerCode)) {
          state.feedback = {
            message: 'Enter a valid Player_Code using letters and digits.',
            tone: 'error',
          };
          feedback.replaceChildren(
            createAlert(document, { message: state.feedback.message, tone: 'error' }),
          );
          input.focus();
          return;
        }
        if (playerCode === String(snapshot.profile.playerCode).toUpperCase()) {
          state.feedback = {
            message: 'Self-verification is not allowed. Enter another participant’s Player_Code.',
            tone: 'error',
          };
          feedback.replaceChildren(
            createAlert(document, { message: state.feedback.message, tone: 'error' }),
          );
          input.focus();
          return;
        }
        // Same rule as the server: a participant is only unavailable while a
        // request to them is pending, or once they have actually confirmed a
        // square. Cancelled and rejected requests free them to be asked again.
        const activeForCode = snapshot.verificationRequests.find(
          (request) =>
            request.requestingParticipant.participantId === snapshot.profile.participantId &&
            String(request.identifiedParticipant.playerCode).toUpperCase() === playerCode &&
            (request.status === VerificationRequestStatus.Pending ||
              request.status === VerificationRequestStatus.Confirmed),
        );
        if (activeForCode !== undefined) {
          state.feedback = {
            message:
              activeForCode.status === VerificationRequestStatus.Pending
                ? activeForCode.squareIndex === selected.squareIndex
                  ? 'A verification request to this Player_Code is already pending for this square.'
                  : 'You already have a pending request to this Player_Code on your grid. Cancel it before asking them for a different square.'
                : 'This Player_Code already verified a square on your grid. Each participant can verify only one square.',
            tone: 'error',
          };
          feedback.replaceChildren(
            createAlert(document, { message: state.feedback.message, tone: 'error' }),
          );
          input.focus();
          return;
        }
        state.feedback = { message: 'Submitting verification request…', tone: 'info' };
        submit.disabled = true;
        submit.classList.add('button--busy');
        void actions
          .requestVerification(selected.squareIndex, playerCode)
          .then(() => {
            state.feedback = { message: 'Verification request sent.', tone: 'success' };
            announce('Verification request sent.');
          })
          .catch((error: unknown) => {
            state.feedback = {
              message:
                error instanceof Error ? error.message : 'The Player_Code could not be verified.',
              tone: 'error',
            };
            feedback.replaceChildren(
              createAlert(document, { message: state.feedback.message, tone: 'error' }),
            );
            submit.disabled = false;
            submit.classList.remove('button--busy');
            input.focus();
          });
      });
      dialogContent.append(form);
    }
    queueMicrotask(() => {
      if (
        !verificationDialog.open &&
        state.selectedSquareIndex !== null &&
        verificationDialog.isConnected
      ) {
        verificationDialog.showModal();
      }
    });
  };

  for (const square of squares) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `square-button-${square.squareIndex}`;
    button.className = `bingo-square square--${square.status}`;
    button.dataset.squareIndex = String(square.squareIndex);
    button.setAttribute(
      'aria-label',
      `Row ${square.row}, column ${square.column}: ${square.taskText}. Status: ${createStatusText(square.status)}.`,
    );
    button.setAttribute('aria-rowindex', String(square.row));
    button.setAttribute('aria-colindex', String(square.column));
    button.disabled =
      square.status === SquareStatus.Verified || snapshot.game.status === GameStatus.Closed;
    const task = document.createElement('span');
    task.className = 'square-task';
    task.textContent = square.taskText;
    button.append(task);
    button.addEventListener('focus', () => {
      state.focusTarget = button.id;
    });
    button.addEventListener('click', () => {
      state.selectedSquareIndex = square.squareIndex;
      delete state.feedback;
      state.focusTarget = button.id;
      for (const other of squareButtons.values()) other.classList.remove('bingo-square--selected');
      button.classList.add('bingo-square--selected');
      renderVerificationDialog();
      announce(`Selected row ${square.row}, column ${square.column}.`);
    });
    squareButtons.set(square.squareIndex, button);
    grid.append(button);
  }
  gridWrap.append(grid);
  gridCard.append(gridHeading, gridHelp, gridLegend, gridWrap, verificationDialog);
  layout.append(
    gridCard,
    createNotifications(document, snapshot, state, actions, announce),
    createVerificationHistory(document, snapshot),
  );
  page.append(layout, createLeaderboards(document, snapshot));
  renderVerificationDialog();
  if (state.selectedSquareIndex !== null)
    squareButtons.get(state.selectedSquareIndex)?.classList.add('bingo-square--selected');
  focusAfterRender(document, state);
  return page;
}

function createStatusText(status: SquareStatus): string {
  switch (status) {
    case SquareStatus.Unverified:
      return 'Unverified';
    case SquareStatus.Pending:
      return 'Pending';
    case SquareStatus.Rejected:
      return 'Rejected';
    case SquareStatus.Verified:
      return 'Verified';
  }
}
