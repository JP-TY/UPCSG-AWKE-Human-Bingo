'use client';

import Image from 'next/image';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { GameStatus } from '@human-bingo/domain';
import type { CreateInvitationResult, InvitationRepresentationDto } from '../lib/types';
import { apiFetch, HumanBingoApiError, mutateApi, mutateGame } from '../lib/api';
import type { HostGameDto } from '../lib/types';
import { AKWE_STARTER_TASKS } from '../lib/starter-tasks';
import { CopyButton } from './CopyButton';
import { Leaderboards } from './Leaderboards';
import { QrCode } from './QrCode';

export function HostDesk({ gameId }: { gameId: string }) {
  const [hostData, setHostData] = useState<HostGameDto | null>(null);
  const [invitation, setInvitation] = useState<InvitationRepresentationDto | null>(null);
  const [newTasks, setNewTasks] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(
    null,
  );

  const loadHost = useCallback(async () => {
    const next = await apiFetch<HostGameDto>(`/api/games/${encodeURIComponent(gameId)}/host`);
    setHostData(next);
    setDrafts(Object.fromEntries(next.tasks.map((task) => [String(task.id), task.text])));
  }, [gameId]);

  const loadInvitation = useCallback(async () => {
    const result = await mutateApi<CreateInvitationResult>(
      `/api/games/${encodeURIComponent(gameId)}/invitation`,
      {},
    );
    setInvitation(result.invitation);
  }, [gameId]);

  useEffect(() => {
    let current = true;
    void apiFetch<HostGameDto>(`/api/games/${encodeURIComponent(gameId)}/host`)
      .then((result) => {
        if (!current) return;
        setHostData(result);
        setDrafts(Object.fromEntries(result.tasks.map((task) => [String(task.id), task.text])));
        if (result.game.status !== GameStatus.Draft) {
          void mutateApi<CreateInvitationResult>(
            `/api/games/${encodeURIComponent(gameId)}/invitation`,
            {},
          )
            .then((value) => {
              if (current) setInvitation(value.invitation);
            })
            .catch(() => undefined);
        }
      })
      .catch((error: unknown) => {
        if (current)
          setFeedback({
            tone: 'error',
            text: messageFor(
              error,
              'The host desk could not be opened. Return to the host browser and retry.',
            ),
          });
      });
    return () => {
      current = false;
    };
  }, [gameId]);

  const taskCount = hostData?.game.distinctTaskCount ?? 0;
  const missingTasks = Math.max(0, 25 - taskCount);
  const bagLocked = hostData?.game.taskBagLocked ?? false;

  const runMutation = async (key: string, action: () => Promise<unknown>, successText: string) => {
    setBusy(key);
    setFeedback(null);
    try {
      await action();
      await loadHost();
      setFeedback({ tone: 'success', text: successText });
    } catch (error) {
      setFeedback({
        tone: 'error',
        text: messageFor(error, 'That change could not be saved. Please retry.'),
      });
      if (error instanceof HumanBingoApiError && error.status === 409)
        await loadHost().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  const addTasks = async (texts: readonly string[]) => {
    if (hostData === null || texts.length === 0) return;
    await runMutation(
      'add-tasks',
      () =>
        mutateGame(gameId, {
          action: 'add_tasks',
          texts,
          knownStateVersion: Number(hostData.game.stateVersion),
        }),
      `Added ${texts.length} task${texts.length === 1 ? '' : 's'} to the bag.`,
    );
  };

  const addManualTasks = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const texts = newTasks
      .split(/\r?\n/)
      .map((text) => text.trim())
      .filter(Boolean);
    await addTasks(texts);
    setNewTasks('');
  };

  const loadStarterBag = async () => {
    const current = new Set(
      (hostData?.tasks ?? []).map((task) => task.text.trim().toLocaleLowerCase('en-US')),
    );
    const tasks = AKWE_STARTER_TASKS.filter(
      (task) => !current.has(task.toLocaleLowerCase('en-US')),
    );
    await addTasks(tasks);
  };

  const saveTask = async (taskId: string) => {
    if (hostData === null) return;
    const text = drafts[taskId]?.trim() ?? '';
    if (!text) {
      setFeedback({ tone: 'error', text: 'Task text is required. Add a few words before saving.' });
      return;
    }
    await runMutation(
      `save-${taskId}`,
      () =>
        mutateGame(gameId, {
          action: 'edit_task',
          taskEntryId: taskId,
          text,
          knownStateVersion: Number(hostData.game.stateVersion),
        }),
      'Task saved.',
    );
  };

  const removeTask = async (taskId: string) => {
    if (hostData === null) return;
    await runMutation(
      `remove-${taskId}`,
      () =>
        mutateGame(gameId, {
          action: 'remove_task',
          taskEntryId: taskId,
          knownStateVersion: Number(hostData.game.stateVersion),
        }),
      'Task removed.',
    );
  };

  const openGame = async () => {
    if (hostData === null) return;
    setBusy('open');
    setFeedback(null);
    try {
      await mutateGame(gameId, {
        action: 'open',
        knownStateVersion: Number(hostData.game.stateVersion),
      });
      await loadHost();
      await loadInvitation();
      setFeedback({ tone: 'success', text: 'Invitations are open. Share the code or QR card.' });
    } catch (error) {
      setFeedback({
        tone: 'error',
        text: messageFor(error, 'The game could not be opened. Check the task bag and retry.'),
      });
      await loadHost().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  const closeGame = async () => {
    if (hostData === null) return;
    await runMutation(
      'close',
      () =>
        mutateGame(gameId, {
          action: 'close',
          knownStateVersion: Number(hostData.game.stateVersion),
        }),
      'Game closed. Existing cards and standings remain available.',
    );
  };

  const participants = hostData?.overview.participants ?? [];
  const gameStateLabel = useMemo(() => {
    switch (hostData?.game.status) {
      case GameStatus.Draft:
        return 'Draft table';
      case GameStatus.InvitationAvailable:
        return 'Invites open';
      case GameStatus.Active:
        return 'Game in play';
      case GameStatus.Closed:
        return 'Game closed';
      default:
        return 'Loading host desk';
    }
  }, [hostData?.game.status]);

  if (hostData === null) {
    return (
      <section className="page-wrap page-flow" aria-labelledby="host-loading-title">
        <p className="section-mark">THE HOST TABLE</p>
        <h1 className="page-loading-title" id="host-loading-title">
          Setting out the cards
        </h1>
        {feedback?.tone === 'error' ? (
          <p className="form-message form-message--error" role="alert">
            {feedback.text}
          </p>
        ) : (
          <p role="status">Checking your game and task bag.</p>
        )}
      </section>
    );
  }

  return (
    <div className="page-wrap page-flow host-desk">
      <header className="page-heading host-heading">
        <span className="section-mark">THE HOST TABLE · {gameStateLabel.toUpperCase()}</span>
        <h1>Set out the cards.</h1>
        <p>{hostData.game.name}. The task bag locks when the first guest joins.</p>
      </header>

      {feedback ? (
        <p
          className={`form-message form-message--${feedback.tone}`}
          role={feedback.tone === 'error' ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      ) : null}

      <div className="host-layout">
        <div className="host-main-column">
          <section className="task-bag-section" aria-labelledby="task-bag-title">
            <div className="section-heading">
              <div>
                <span className="section-mark">INDEX CARDS</span>
                <h2 id="task-bag-title">The task bag</h2>
              </div>
              <span className="task-progress">
                <strong>{taskCount}</strong> distinct / 25 needed
              </span>
            </div>

            {bagLocked ? (
              <p className="form-message form-message--success" role="status">
                The task bag is locked after the first participant joined.
              </p>
            ) : (
              <div className="starter-bag-row">
                <p>Start with event prompts, then edit them to fit your room.</p>
                <button
                  className="action-button"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void loadStarterBag()}
                >
                  Load AKWE starter prompts
                </button>
              </div>
            )}

            <ol className="task-list">
              {hostData.tasks.map((task, index) => {
                const taskId = String(task.id);
                return (
                  <li className="task-item" key={taskId}>
                    <span className="task-item__number">{String(index + 1).padStart(2, '0')}</span>
                    <label className="visually-hidden" htmlFor={`task-${taskId}`}>
                      Task {task.text}
                    </label>
                    <input
                      id={`task-${taskId}`}
                      aria-label={`Task ${task.text}`}
                      value={drafts[taskId] ?? task.text}
                      disabled={bagLocked || busy !== null}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [taskId]: event.currentTarget.value,
                        }))
                      }
                    />
                    {!bagLocked ? (
                      <div className="task-item__actions">
                        <button
                          className="action-button action-button--quiet"
                          type="button"
                          disabled={busy !== null || (drafts[taskId] ?? task.text) === task.text}
                          onClick={() => void saveTask(taskId)}
                        >
                          Save
                        </button>
                        <button
                          className="action-button action-button--quiet"
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void removeTask(taskId)}
                        >
                          Remove
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>

            {!bagLocked ? (
              <form className="add-tasks-form" onSubmit={(event) => void addManualTasks(event)}>
                <div className="field-group">
                  <label htmlFor="new-tasks">Add tasks</label>
                  <textarea
                    id="new-tasks"
                    value={newTasks}
                    onChange={(event) => setNewTasks(event.currentTarget.value)}
                    placeholder={'One task per line\nHas used AWS CDK'}
                    aria-describedby="new-tasks-help"
                  />
                  <p id="new-tasks-help" className="field-help">
                    One prompt per line. Duplicate prompts are skipped by the game.
                  </p>
                </div>
                <button
                  className="action-button action-button--primary"
                  type="submit"
                  disabled={busy !== null || newTasks.trim().length === 0}
                >
                  Add tasks
                </button>
              </form>
            ) : null}
          </section>

          {hostData.overview.participants.length > 0 ? (
            <section className="host-participant-section" aria-labelledby="participants-title">
              <div className="section-heading">
                <div>
                  <span className="section-mark">GUESTS AROUND THE TABLE</span>
                  <h2 id="participants-title">Joined people</h2>
                </div>
                <span>{participants.length} joined</span>
              </div>
              <ul className="host-participants">
                {participants.map((participant) => (
                  <li className="participant-item" key={participant.participant.participantId}>
                    <div>
                      <strong>{participant.participant.displayName}</strong>
                      <span>{participant.participant.playerCode}</span>
                    </div>
                    <p>{participant.verifiedSquares} of 25 squares verified</p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {hostData.overview.participants.length > 0 ? (
            <Leaderboards leaderboards={hostData.overview.leaderboards} />
          ) : null}
        </div>

        <aside className="host-side-column" aria-label="Invitation and game controls">
          <section className="paper-scrap invite-scrap" aria-labelledby="invite-title">
            <span className="section-mark">SHARE THE CARD</span>
            <h2 id="invite-title">Invite players</h2>
            {invitation ? (
              <>
                <output aria-label="Join Code" className="join-code-display">
                  {invitation.joinCode}
                </output>
                <div className="invite-scrap__actions">
                  <CopyButton value={invitation.joinCode} label="Copy join code" />
                  <CopyButton value={invitation.canonicalLink} label="Copy invitation link" />
                </div>
                <p className="join-at">Join at {invitation.canonicalLink}</p>
                <QrCode value={invitation.canonicalLink} payload={invitation.qrPayload} />
              </>
            ) : hostData.game.status === GameStatus.Draft ? (
              <p>Open invitations when your bag has at least 25 distinct prompts.</p>
            ) : (
              <button
                className={`action-button${busy === 'invitation' ? ' action-button--loading' : ''}`}
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  setBusy('invitation');
                  setFeedback(null);
                  void loadInvitation()
                    .then(() => setFeedback({ tone: 'success', text: 'Invite card ready.' }))
                    .catch((error: unknown) =>
                      setFeedback({
                        tone: 'error',
                        text: messageFor(error, 'The invitation could not be loaded.'),
                      }),
                    )
                    .finally(() => setBusy(null));
                }}
              >
                Show invitation
              </button>
            )}
          </section>

          <section className="game-controls" aria-labelledby="game-controls-title">
            <span className="section-mark">ROUND CONTROLS</span>
            <h2 id="game-controls-title">Game controls</h2>
            {hostData.game.status === GameStatus.Draft ? (
              <>
                {missingTasks > 0 ? (
                  <p>
                    Add {missingTasks} more distinct task{missingTasks === 1 ? '' : 's'} to open
                    this game.
                  </p>
                ) : (
                  <p>Your task bag is ready to share.</p>
                )}
                <button
                  className={`action-button action-button--primary${busy === 'open' ? ' action-button--loading' : ''}`}
                  type="button"
                  disabled={busy !== null || missingTasks > 0}
                  onClick={() => void openGame()}
                >
                  Open invitations
                </button>
              </>
            ) : hostData.game.status === GameStatus.Closed ? (
              <p className="form-message form-message--success" role="status">
                This game is closed. Existing cards and standings remain available.
              </p>
            ) : (
              <>
                <p>Guests can join and request stamps while this round is open.</p>
                <button
                  className="action-button action-button--danger"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void closeGame()}
                >
                  Close game
                </button>
              </>
            )}
          </section>

          <div className="host-art-note" aria-hidden="true">
            <Image src="/brand/stickers/07.webp" alt="" width={92} height={92} />
            <span className="biro-note">
              good cards
              <br />
              start good chats
            </span>
          </div>
        </aside>
      </div>
    </div>
  );
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof HumanBingoApiError ? error.message : fallback;
}
