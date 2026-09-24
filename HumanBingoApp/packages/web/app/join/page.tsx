import type { Metadata } from 'next';
import { JoinFlow } from '../components/JoinFlow';

export const metadata: Metadata = {
  title: 'Join a game',
  description: 'Enter your AKWE 2026 Human Bingo code and pick up a card.',
};

export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ readonly token?: string; readonly code?: string }>;
}) {
  const params = await searchParams;
  return (
    <div className="page-wrap page-flow">
      <JoinFlow initialToken={params.token} initialCode={params.code} />
    </div>
  );
}
