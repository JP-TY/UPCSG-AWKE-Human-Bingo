export default function Loading() {
  return (
    <section className="page-wrap page-flow" aria-labelledby="loading-title" aria-busy="true">
      <span className="section-mark">CUTTING THE PAPER</span>
      <h1 className="page-loading-title" id="loading-title">
        Loading your game
      </h1>
      <div className="loading-board" aria-hidden="true">
        {Array.from({ length: 10 }, (_, index) => (
          <span className="inline-skeleton" key={index} />
        ))}
      </div>
      <p role="status">Getting the latest card and stamp count.</p>
    </section>
  );
}
