'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

interface LastGame {
  readonly gameId: string;
  readonly displayName: string;
  readonly role: 'host' | 'player';
}

export function ResumeLastGame() {
  const [lastGame, setLastGame] = useState<LastGame | null>(null);

  useEffect(() => {
    try {
      const value = localStorage.getItem('human-bingo:last-game');
      if (value === null) return;
      const parsed: unknown = JSON.parse(value);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'gameId' in parsed &&
        typeof parsed.gameId === 'string' &&
        'displayName' in parsed &&
        typeof parsed.displayName === 'string' &&
        'role' in parsed &&
        (parsed.role === 'host' || parsed.role === 'player')
      ) {
        setLastGame(parsed as LastGame);
      }
    } catch {
      setLastGame(null);
    }
  }, []);

  if (lastGame === null) return null;

  const target =
    lastGame.role === 'host' ? `/game/${lastGame.gameId}/host` : `/game/${lastGame.gameId}`;
  return (
    <div className="resume-strip">
      <p>Welcome back, {lastGame.displayName}. Your last card is ready.</p>
      <Link className="action-link action-link--primary" href={target}>
        Open your game
      </Link>
    </div>
  );
}
