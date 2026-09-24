import type { Metadata } from 'next';
import { InvitePreview } from '../../components/InvitePreview';

export const metadata: Metadata = {
  title: 'Invitation preview',
  description: 'Check the Human Bingo invitation shared with you.',
};

export default async function InvitePage({
  params,
}: {
  params: Promise<{ readonly token: string }>;
}) {
  const { token } = await params;
  return <InvitePreview token={token} />;
}
