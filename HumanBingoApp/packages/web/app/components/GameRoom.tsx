'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { GameStatus, NotificationStatus, SquareStatus } from '@human-bingo/domain';
import type { GridSquareDto, NotificationDto, VerificationRequestDto } from '../lib/types';
import { HumanBingoApiError, mutateApi } from '../lib/api';
import { useGameSession } from '../lib/useGameSession';
import { CopyButton } from './CopyButton';
import { GameBoard } from './GameBoard';
import { Leaderboards } from './Leaderboards';
import { StatusLegend } from './StatusLegend';

type GameRoomMode = 'member' | 'notifications';

export function GameRoom({ gameId, mode = 'member' }: { gameId: string; mode?: GameRoomMode }) {
  const { view, status: connection, error: syncError, refresh } = useGameSession(gameId);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [playerCode, setPlayerCode] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(
    null,
  );

  const squares = useMemo(
    () =>
      [...(view?.squares.values() ?? [])].sort(
        (left, right) => left.squareIndex - right.squareIndex,
      ),
    [view],
  );
  const selectedSquare = squares.find((square) => square.squareIndex === selectedIndex) ?? null;
  const notifications = useMemo(
    () =>
      [...(view?.notifications.values() ?? [])].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      ),
    [view],
  );
  const myRequestHistory = useMemo(() => {
    const participantId = String(view?.participant.id ?? '');
    return [...(view?.verificationRequests.values() ?? [])]
      .filter((request) => String(request.requestingParticipant.participantId) === participantId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }, [view]);

  if (view === null) {
    return (
      <section className="page-wrap page-flow" aria-labelledby="game-loading-title">
        <p className="section-mark">AKWE 2026 · YOUR GAME</p>
        <h1 className="page-loading-title" id="game-loading-title">
          Getting your card ready
        </h1>
        <div className="inline-skeleton" aria-hidden="true" />
        <p role="status">{syncError ?? 'Checking the game board and your saved progress.'}</p>
        {syncError ? (
          <Link className="action-link" href="/join">
            Return to join
          </Link>
        ) : null}
      </section>
    );
  }

  const isClosed = view.game.status === GameStatus.Closed;
  const pendingNotifications = notifications.filter(
    (notification) => notification.status === NotificationStatus.Pending,
  );
  const resolvedNotifications = notifications.filter(
    (notification) => notification.status === NotificationStatus.Resolved,
  );
  const submitVerification = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedSquare === null || view === null) return;

    setBusyKey('request');
    setFeedback(null);
    try {
      await mutateApi(`/api/games/${encodeURIComponent(gameId)}/verification-requests`, {
        gridId: view.grid.id,
        squareIndex: selectedSquare.squareIndex,
        identifiedPlayerCode: playerCode.trim().toUpperCase(),
        knownStateVersion: Number(view.stateVersion),
      });
      setPlayerCode('');
      setFeedback({
        tone: 'success',
        message: 'Request sent. Ask them to check their game inbox.',
      });
      await refresh();
    } catch (error) {
      setFeedback({
        tone: 'error',
        message: messageFor(error, 'The request did not go through. Check the code and try again.'),
      });
      if (error instanceof HumanBingoApiError && error.status === 409) await refresh();
    } finally {
      setBusyKey(null);
    }
  };

  const respondToRequest = async (
    notification: NotificationDto,
    decision: 'confirm' | 'reject',
  ) => {
    if (view === null) return;
    const actionKey = `${notification.id}:${decision}`;
    setBusyKey(actionKey);
    setFeedback(null);
    try {
      await mutateApi(
        `/api/verification-requests/${encodeURIComponent(String(notification.verificationRequestId))}/${decision}`,
        {
          gameId,
          knownStateVersion: Number(view.stateVersion),
        },
      );
      setFeedback({
        tone: 'success',
        message:
          decision === 'confirm'
            ? 'Confirmed. Their square now has a face-stamp.'
            : 'Request declined. Their square stays open.',
      });
      await refresh();
    } catch (error) {
      setFeedback({
        tone: 'error',
        message: messageFor(error, 'We could not update this request. Please retry.'),
      });
      if (error instanceof HumanBingoApiError && error.status === 409) await refresh();
    } finally {
      setBusyKey(null);
    }
  };

  const squareStatusText = (square: GridSquareDto): string => {
    switch (square.status) {
      case SquareStatus.Pending:
        return 'Someone is checking this one.';
      case SquareStatus.Rejected:
        return 'That one can be tried with another person.';
      case SquareStatus.Verified:
        return 'Stamped and counted.';
      default:
        return 'Find a person who fits, then ask for their Player Code.';
    }
  };

  return (
    <div className="page-wrap page-flow">
      <header className="game-identity">
        <div>
          <p className="section-mark">AKWE 2026 · HUMAN BINGO</p>
          <h1>{mode === 'notifications' ? 'Your game inbox' : view.game.name}</h1>
          <p>Welcome back, {view.profile.displayName}.</p>
        </div>
        <div className="game-identity__tools">
          <span
            className="player-code-chip"
            aria-label={`Your Player Code: ${view.profile.playerCode}`}
          >
            <small>YOUR PLAYER CODE</small>
            <strong>{view.profile.playerCode}</strong>
          </span>
          <span
            className={`game-status-line${connection === 'reconnecting' ? ' game-status-line--reconnecting' : ''}`}
            role="status"
          >
            <span
              className={`sync-dot${connection === 'reconnecting' ? ' sync-dot--reconnecting' : ''}`}
              aria-hidden="true"
            />
            {connection === 'connected'
              ? 'In sync'
              : connection === 'reconnecting'
                ? 'Reconnecting'
                : 'Loading'}
          </span>
        </div>
      </header>

      {feedback ? (
        <p
          className={`form-message form-message--${feedback.tone}`}
          role={feedback.tone === 'error' ? 'alert' : 'status'}
        >
          {feedback.message}
        </p>
      ) : null}

      {isClosed ? (
        <p className="form-message form-message--success" role="status">
          This game is closed. Your verified squares and final standings are still here.
        </p>
      ) : null}

      {mode === 'member' ? (
        <div className="game-layout">
          <div className="game-main-column">
            <section aria-labelledby="grid-title">
              <div className="section-heading">
                <h2 id="grid-title">Your 5×5 card</h2>
                <p>
                  {squares.filter((square) => square.status === SquareStatus.Verified).length}{' '}
                  face-stamped
                </p>
              </div>
              <p className="grid-instructions">
                Tap an open square after you meet someone who fits. They confirm it from their
                inbox.
              </p>
              <GameBoard
                squares={squares}
                closed={isClosed}
                selectedIndex={selectedIndex}
                onSelect={(square) => {
                  setSelectedIndex(square.squareIndex);
                  setFeedback(null);
                }}
              />
              <StatusLegend />

              {selectedSquare ? (
                <section
                  className="selected-square"
                  id="selected-square"
                  aria-labelledby="selected-task-title"
                >
                  <p className="section-mark">SQUARE {selectedSquare.squareIndex + 1}</p>
                  <h3 id="selected-task-title">{selectedSquare.taskText}</h3>
                  <p>{squareStatusText(selectedSquare)}</p>
                  {selectedSquare.status === SquareStatus.Rejected && !isClosed ? (
                    <form
                      className="selected-square__form"
                      onSubmit={(event) => void submitVerification(event)}
                    >
                      <div className="field-group">
                        <label htmlFor="verification-player-code">Participant Player_Code</label>
                        <input
                          id="verification-player-code"
                          name="playerCode"
                          autoComplete="off"
                          value={playerCode}
                          onChange={(event) => setPlayerCode(event.currentTarget.value)}
                          placeholder="A1B2C3"
                          aria-describedby="player-code-help"
                          maxLength={12}
                          required
                        />
                        <p className="field-help" id="player-code-help">
                          Use the code shown on their card.
                        </p>
                      </div>
                      <button
                        className={`action-button action-button--primary${busyKey === 'request' ? ' action-button--loading' : ''}`}
                        type="submit"
                        disabled={busyKey !== null || isClosed}
                      >
                        Request verification
                      </button>
                    </form>
                  ) : null}
                  {selectedSquare.status === SquareStatus.Unverified && !isClosed ? (
                    <form
                      className="selected-square__form"
                      onSubmit={(event) => void submitVerification(event)}
                    >
                      <div className="field-group">
                        <label htmlFor="verification-player-code">Participant Player_Code</label>
                        <input
                          id="verification-player-code"
                          name="playerCode"
                          autoComplete="off"
                          value={playerCode}
                          onChange={(event) => setPlayerCode(event.currentTarget.value)}
                          placeholder="A1B2C3"
                          aria-describedby="player-code-help"
                          maxLength={12}
                          required
                        />
                        <p className="field-help" id="player-code-help">
                          Ask them to read the code from their card.
                        </p>
                      </div>
                      <button
                        className={`action-button action-button--primary${busyKey === 'request' ? ' action-button--loading' : ''}`}
                        type="submit"
                        disabled={busyKey !== null || isClosed}
                      >
                        Request verification
                      </button>
                    </form>
                  ) : null}
                </section>
              ) : null}
            </section>

            <Leaderboards leaderboards={view.leaderboards} />
          </div>

          <aside className="game-side-column" aria-label="Game activity">
            <NotificationInbox
              notifications={pendingNotifications}
              busyKey={busyKey}
              disabled={isClosed}
              onRespond={respondToRequest}
            />
            <VerificationHistory requests={myRequestHistory} />
            <div className="paper-scrap paper-scrap--tape game-shortcuts">
              <h2>Keep your card handy</h2>
              <CopyButton value={view.profile.playerCode} label="Copy Player Code" />
              <Link
                className="action-link"
                href={`/game/${encodeURIComponent(gameId)}/notifications`}
              >
                Open inbox and history
              </Link>
            </div>
          </aside>
        </div>
      ) : (
        <section className="notification-page-layout" aria-labelledby="inbox-title">
          <div className="section-heading">
            <h2 id="inbox-title">Requests to you</h2>
            <p>{pendingNotifications.length} waiting</p>
          </div>
          <NotificationInbox
            notifications={pendingNotifications}
            busyKey={busyKey}
            disabled={isClosed}
            onRespond={respondToRequest}
          />
          <div className="section-heading section-heading--history">
            <h2>Resolved requests</h2>
            <Link href={`/game/${encodeURIComponent(gameId)}`}>Back to your card</Link>
          </div>
          {resolvedNotifications.length === 0 ? (
            <p className="empty-note">
              No resolved requests yet. When you confirm a square, it gets a face-stamp.
            </p>
          ) : (
            <ul className="inbox-list">
              {resolvedNotifications.map((notification) => (
                <li className="inbox-item inbox-item--resolved" key={notification.id}>
                  <p>
                    <strong>{notification.requestingParticipant.displayName}</strong> asked about:
                  </p>
                  <p>{notification.taskText}</p>
                  <span className="notification-status">Request resolved</span>
                </li>
              ))}
            </ul>
          )}
          <VerificationHistory requests={myRequestHistory} />
        </section>
      )}
    </div>
  );
}

function NotificationInbox({
  notifications,
  busyKey,
  disabled,
  onRespond,
}: {
  notifications: readonly NotificationDto[];
  busyKey: string | null;
  disabled: boolean;
  onRespond: (notification: NotificationDto, decision: 'confirm' | 'reject') => Promise<void>;
}) {
  return (
    <section className="inbox-section" aria-labelledby="inbox-section-title">
      <div className="section-heading">
        <h2 id="inbox-section-title">A quick check from someone</h2>
        <span>{notifications.length} waiting</span>
      </div>
      {notifications.length === 0 ? (
        <p className="empty-note">
          Nothing waiting. Keep meeting people and your inbox will catch the requests.
        </p>
      ) : (
        <ul className="inbox-list">
          {notifications.map((notification) => (
            <li className="inbox-item inbox-item--pending" key={notification.id}>
              <p>
                <strong>{notification.requestingParticipant.displayName}</strong> says this fits
                you:
              </p>
              <p className="inbox-item__task">{notification.taskText}</p>
              <div className="inbox-item__actions">
                <button
                  className={`action-button action-button--primary${busyKey === `${notification.id}:confirm` ? ' action-button--loading' : ''}`}
                  type="button"
                  aria-label={`Confirm verification request from ${notification.requestingParticipant.displayName}`}
                  disabled={disabled || busyKey !== null}
                  onClick={() => void onRespond(notification, 'confirm')}
                >
                  Yes, stamp it
                </button>
                <button
                  className={`action-button action-button--quiet${busyKey === `${notification.id}:reject` ? ' action-button--loading' : ''}`}
                  type="button"
                  aria-label={`Reject verification request from ${notification.requestingParticipant.displayName}`}
                  disabled={disabled || busyKey !== null}
                  onClick={() => void onRespond(notification, 'reject')}
                >
                  Not this one
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function VerificationHistory({ requests }: { requests: readonly VerificationRequestDto[] }) {
  return (
    <section className="history-section" aria-labelledby="history-title">
      <div className="section-heading">
        <h2 id="history-title">Your asks</h2>
        <span>{requests.length}</span>
      </div>
      {requests.length === 0 ? (
        <p className="empty-note">Your first square starts with a conversation.</p>
      ) : (
        <ul className="inbox-list">
          {requests.slice(0, 6).map((request) => (
            <li className="inbox-item" key={request.id}>
              <p className="inbox-item__task">{request.taskText}</p>
              <p>
                {request.status === 'pending'
                  ? `Waiting on ${request.identifiedParticipant.displayName}.`
                  : request.status === 'confirmed'
                    ? 'Confirmed and face-stamped.'
                    : 'Declined. You can ask someone else.'}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof HumanBingoApiError ? error.message : fallback;
}
