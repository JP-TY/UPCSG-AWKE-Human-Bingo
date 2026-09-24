'use client';

import Link from 'next/link';

export default function ApplicationError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="page-wrap error-page" role="alert">
      <span className="section-mark">A PAGE FELL OFF THE BOARD</span>
      <h1>That did not go to plan.</h1>
      <p>Your game data is still on the server. Try the page again or return to the event card.</p>
      <div className="button-row">
        <button className="action-button action-button--primary" type="button" onClick={reset}>
          Try this page again
        </button>
        <Link className="action-link" href="/">
          Return home
        </Link>
      </div>
    </section>
  );
}
