import Link from 'next/link';

export default function NotFound() {
  return (
    <section className="page-wrap error-page">
      <span className="section-mark">WRONG SCRAP</span>
      <h1>That page is not on this board.</h1>
      <p>
        The link may be old or the game may have moved. Head back and ask your host for the right
        card.
      </p>
      <Link className="action-link action-link--primary" href="/">
        Return to AKWE Human Bingo
      </Link>
    </section>
  );
}
