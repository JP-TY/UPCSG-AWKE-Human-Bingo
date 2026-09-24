import type { Metadata } from 'next';
import { HostCreateForm } from '../components/HostCreateForm';

export const metadata: Metadata = {
  title: 'Host a game',
  description: 'Set up a Human Bingo task bag for AKWE 2026.',
};

export default function HostPage() {
  return (
    <div className="page-wrap page-flow host-create-page">
      <header className="page-heading">
        <span className="section-mark">HOST A ROUND</span>
        <h1>Set the table.</h1>
        <p>Make a draft first. Add at least 25 distinct prompts before you open the invitation.</p>
      </header>
      <HostCreateForm />
    </div>
  );
}
