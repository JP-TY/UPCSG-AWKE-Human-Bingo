import type { LeaderboardsDto } from '../lib/types';

export function Leaderboards({ leaderboards }: { leaderboards: LeaderboardsDto }) {
  const categories = [
    {
      title: 'Blackout',
      note: 'Full board',
      entries: leaderboards.blackout.entries,
      total: leaderboards.blackout.totalCompletions,
    },
    {
      title: 'Lines',
      note: 'Rows, columns, diagonals',
      entries: leaderboards.line.entries,
      total: leaderboards.line.entries.reduce((sum, entry) => sum + entry.completionCount, 0),
    },
    {
      title: 'Hashtag',
      note: 'The 16-square pattern',
      entries: leaderboards.hashtag.entries,
      total: leaderboards.hashtag.totalCompletions,
    },
  ];

  return (
    <section className="leaderboard-section" aria-labelledby="leaderboards-title">
      <div className="section-heading">
        <h2 id="leaderboards-title">The score scraps</h2>
        <p>Verified completions only</p>
      </div>
      <div className="leaderboards">
        {categories.map((category, index) => (
          <section
            className={`leaderboard-sheet leaderboard-sheet--${index + 1}`}
            key={category.title}
          >
            <header>
              <div>
                <h3>{category.title}</h3>
                <p>{category.note}</p>
              </div>
              <span
                className="leaderboard-sheet__count"
                aria-label={`${category.total} total completions`}
              >
                {category.total}
              </span>
            </header>
            {category.entries.length === 0 ? (
              <p className="empty-note">No stamps here yet. The first one could be yours.</p>
            ) : (
              <ol className="leaderboard-list">
                {category.entries.slice(0, 5).map((entry, entryIndex) => (
                  <li
                    className="leaderboard-item"
                    key={`${category.title}-${entry.participant.participantId}`}
                  >
                    <span className="leaderboard-item__rank">{entryIndex + 1}.</span>
                    <span className="leaderboard-item__name">{entry.participant.displayName}</span>
                    <span className="leaderboard-item__score">{entry.completionCount}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        ))}
      </div>
    </section>
  );
}
