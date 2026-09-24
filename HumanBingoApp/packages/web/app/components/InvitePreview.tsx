'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { GameStatus, InvitationStatus } from '@human-bingo/domain';
import type { InvitationPreviewDto } from '../lib/types';
import { apiFetch, HumanBingoApiError } from '../lib/api';
import { RansomTitle } from './RansomTitle';

export function InvitePreview({ token }: { token: string }) {
  const [preview, setPreview] = useState<InvitationPreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let current = true;
    void apiFetch<{ preview: InvitationPreviewDto }>(
      `/api/invitations/${encodeURIComponent(token)}`,
    )
      .then((result) => {
        if (current) setPreview(result.preview);
      })
      .catch((caught: unknown) => {
        if (current) {
          setError(
            caught instanceof HumanBingoApiError
              ? caught.message
              : 'We could not open this invitation. Check with your host for a new code.',
          );
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [token]);

  const closed =
    preview !== null &&
    (preview.gameStatus === GameStatus.Closed ||
      preview.invitationStatus !== InvitationStatus.Available);

  return (
    <div className="page-wrap page-flow invite-page">
      <section className="invite-poster">
        <Image src="/brand/logos/akwe.webp" alt="" width={64} height={64} priority />
        <span className="section-mark">AKWE 2026 · INVITATION</span>
        <h1>
          <RansomTitle text="You are invited" size="section" />
        </h1>
        {loading ? <p role="status">Checking this invite.</p> : null}
        {error ? (
          <p className="form-message form-message--error" role="alert">
            {error}
          </p>
        ) : null}
        {preview ? (
          <>
            <h2>{preview.gameName}</h2>
            <output className="join-code-display" aria-label="Join Code">
              {preview.joinCode}
            </output>
            {closed ? (
              <p className="form-message form-message--error" role="alert">
                This invitation is no longer accepting participants.
              </p>
            ) : (
              <p>Bring your name tag and a little curiosity.</p>
            )}
            {closed ? (
              <span className="invite-closed-label">Invitation closed</span>
            ) : (
              <Link
                className="action-link action-link--primary"
                href={`/join?token=${encodeURIComponent(token)}`}
              >
                Continue to onboarding
              </Link>
            )}
          </>
        ) : null}
        {error ? (
          <Link className="action-link" href="/join">
            Enter a join code instead
          </Link>
        ) : null}
      </section>
    </div>
  );
}
