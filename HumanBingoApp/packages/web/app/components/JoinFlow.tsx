'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { GameStatus, InvitationStatus } from '@human-bingo/domain';
import type { InvitationPreviewDto, OnboardingResultDto } from '../lib/types';
import { apiFetch, HumanBingoApiError, rememberGame } from '../lib/api';
import { RansomTitle } from './RansomTitle';

export function JoinFlow({
  initialToken = '',
  initialCode = '',
}: {
  initialToken?: string;
  initialCode?: string;
}) {
  const router = useRouter();
  const [joinCode, setJoinCode] = useState(initialCode.toUpperCase().slice(0, 6));
  const [preview, setPreview] = useState<InvitationPreviewDto | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [onboarding, setOnboarding] = useState<OnboardingResultDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolveInvitation = async (input: { joinCode: string } | { token: string }) => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ preview: InvitationPreviewDto }>('/api/invitations/resolve', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      setPreview(result.preview);
    } catch (caught) {
      setPreview(null);
      setError(
        caught instanceof HumanBingoApiError
          ? caught.message
          : 'We could not find that invitation. Check the code and try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!initialToken) return;
    // Resolve once on invite-link entry. The token is never copied into page text.
    void resolveInvitation({ token: initialToken });
  }, [initialToken]);

  const resolveCode = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = joinCode.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(normalized)) {
      setError('The join code needs exactly six letters or numbers.');
      return;
    }
    await resolveInvitation({ joinCode: normalized });
  };

  const completeOnboarding = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (preview === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ onboarding: OnboardingResultDto }>(
        `/api/games/${encodeURIComponent(String(preview.gameId))}/onboarding`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': newIdempotencyKey() },
          body: JSON.stringify({
            joinCode: preview.joinCode,
            displayName: displayName.trim(),
          }),
        },
      );
      setOnboarding(result.onboarding);
      rememberGame(
        String(result.onboarding.game.id),
        result.onboarding.profile.displayName,
        'player',
      );
    } catch (caught) {
      setError(
        caught instanceof HumanBingoApiError
          ? caught.message
          : 'We could not finish joining. Please retry.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (onboarding !== null) {
    return (
      <section className="join-success paper-form" aria-labelledby="joined-title">
        <span className="section-mark">CARD IN HAND</span>
        <h1 id="joined-title">You joined the game.</h1>
        <p>Show this Player Code when someone asks you to verify a square.</p>
        <output className="player-code-chip player-code-chip--large" aria-label="Your Player Code">
          <small>YOUR PLAYER CODE</small>
          <strong>{onboarding.profile.playerCode}</strong>
        </output>
        <button
          className="action-button action-button--primary"
          type="button"
          onClick={() => router.push(`/game/${encodeURIComponent(String(onboarding.game.id))}`)}
        >
          Open my game
        </button>
      </section>
    );
  }

  const invitationClosed =
    preview?.gameStatus === GameStatus.Closed ||
    (preview?.invitationStatus !== undefined &&
      preview.invitationStatus !== InvitationStatus.Available);

  return (
    <div className="join-layout">
      <section className="join-intro">
        <span className="section-mark">A CARD IS WAITING</span>
        <h1>
          <RansomTitle text="Join the game" size="section" />
        </h1>
        <p>Enter the code from your host, then add the name people know you by.</p>
        <p className="biro-note" aria-hidden="true">
          you can be a little competitive
        </p>
      </section>

      {!preview ? (
        <form
          className="paper-form paper-form--ticket"
          onSubmit={(event) => void resolveCode(event)}
        >
          <div className="paper-form__fields">
            <div className="field-group">
              <label htmlFor="join-code">Six-character join code</label>
              <input
                id="join-code"
                name="joinCode"
                className="join-code-input"
                value={joinCode}
                onChange={(event) =>
                  setJoinCode(event.currentTarget.value.toUpperCase().slice(0, 6))
                }
                placeholder="ABC123"
                autoComplete="off"
                maxLength={6}
                minLength={6}
                pattern="[A-Za-z0-9]{6}"
                title="Enter exactly six letters or numbers."
                aria-describedby="join-code-help"
                onBlur={() => {
                  if (joinCode.length > 0 && !/^[A-Z0-9]{6}$/.test(joinCode)) {
                    setError('The join code needs exactly six letters or numbers.');
                  }
                }}
                required
              />
              <p className="field-help" id="join-code-help">
                Use uppercase letters A–Z and digits 0–9.
              </p>
            </div>
            {error ? (
              <p className="form-message form-message--error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <button
            className={`action-button action-button--primary${busy ? ' action-button--loading' : ''}`}
            type="submit"
            disabled={busy}
          >
            Find my game
          </button>
        </form>
      ) : (
        <div className="join-onboarding-stack">
          <section className="paper-form paper-form--ticket" aria-labelledby="invite-preview-title">
            <span className="section-mark">INVITATION PREVIEW</span>
            <h2 id="invite-preview-title">{preview.gameName}</h2>
            <output aria-label="Join Code" className="join-code-display">
              {preview.joinCode}
            </output>
            {invitationClosed ? (
              <p className="form-message form-message--error" role="alert">
                This invitation is no longer accepting participants.
              </p>
            ) : (
              <p>This is the right card. Add your name to get your board.</p>
            )}
          </section>

          {!invitationClosed ? (
            <form className="paper-form" onSubmit={(event) => void completeOnboarding(event)}>
              <div className="paper-form__fields">
                <div className="field-group">
                  <label htmlFor="display-name">Display name</label>
                  <input
                    id="display-name"
                    name="displayName"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.currentTarget.value)}
                    maxLength={60}
                    autoComplete="nickname"
                    required
                  />
                  <p className="field-help">Choose a name people in the room will recognize.</p>
                </div>
                {error ? (
                  <p className="form-message form-message--error" role="alert">
                    {error}
                  </p>
                ) : null}
              </div>
              <button
                className={`action-button action-button--primary${busy ? ' action-button--loading' : ''}`}
                type="submit"
                disabled={busy || displayName.trim().length === 0}
              >
                Join Human Bingo
              </button>
            </form>
          ) : (
            <Link className="action-link" href="/join">
              Enter another code
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
