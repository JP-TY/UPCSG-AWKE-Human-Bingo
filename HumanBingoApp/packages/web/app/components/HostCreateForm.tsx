'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createGame, HumanBingoApiError, rememberGame } from '../lib/api';

export function HostCreateForm() {
  const router = useRouter();
  const [name, setName] = useState('AKWE 2026 Human Bingo');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await createGame(name.trim());
      rememberGame(String(result.game.id), 'Host', 'host');
      router.push(`/game/${encodeURIComponent(String(result.game.id))}/host`);
    } catch (caught) {
      setError(
        caught instanceof HumanBingoApiError
          ? caught.message
          : 'The draft could not be created. Please retry.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="paper-form paper-scrap--tape" onSubmit={(event) => void submit(event)}>
      <div className="paper-form__fields">
        <div className="field-group">
          <label htmlFor="game-name">Game name</label>
          <input
            id="game-name"
            name="name"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            maxLength={80}
            required
          />
          <p className="field-help">A short name helps your guests spot the right card.</p>
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
        disabled={busy || name.trim().length === 0}
      >
        Create draft
      </button>
    </form>
  );
}
