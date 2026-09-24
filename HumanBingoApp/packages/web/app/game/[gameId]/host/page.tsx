import type { Metadata } from 'next';
import { HostDesk } from '../../../components/HostDesk';

export const metadata: Metadata = {
  title: 'Host setup',
  description: 'Manage your AKWE Human Bingo game and invitations.',
};

export default async function HostGamePage({
  params,
}: {
  params: Promise<{ readonly gameId: string }>;
}) {
  const { gameId } = await params;
  return <HostDesk gameId={gameId} />;
}
