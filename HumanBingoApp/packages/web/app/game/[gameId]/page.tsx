import type { Metadata } from 'next';
import { GameRoom } from '../../components/GameRoom';

export const metadata: Metadata = {
  title: 'Your game',
  description: 'Your verified AKWE Human Bingo card.',
};

export default async function GamePage({
  params,
}: {
  params: Promise<{ readonly gameId: string }>;
}) {
  const { gameId } = await params;
  return <GameRoom gameId={gameId} />;
}
