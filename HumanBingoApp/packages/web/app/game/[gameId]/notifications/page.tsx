import type { Metadata } from 'next';
import { GameRoom } from '../../../components/GameRoom';

export const metadata: Metadata = {
  title: 'Game inbox',
  description: 'Confirm or decline Human Bingo verification requests.',
};

export default async function NotificationsPage({
  params,
}: {
  params: Promise<{ readonly gameId: string }>;
}) {
  const { gameId } = await params;
  return <GameRoom gameId={gameId} mode="notifications" />;
}
