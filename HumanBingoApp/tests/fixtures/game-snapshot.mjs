export const gameId = 'game-ake-2026';
export const gridId = 'grid-ake-2026';
export const playerId = 'player-ake-01';
export const requesterId = 'player-ake-02';

export const taskTexts = [
  'Find someone who has used Lambda',
  'Find someone who uses CDK',
  'Find someone who has a home lab',
  'Find someone who has built an app',
  'Find someone who likes debugging',
  'Find someone who has an AWS certification',
  'Find someone who has given a tech talk',
  'Find someone who has used a container',
  'Find someone who has tried a new service',
  'Find someone who has mentored a friend',
  'Find someone who likes Cebuano food',
  'Find someone who has been to a meetup',
  'Find someone who has shipped a website',
  'Find someone who has used Terraform',
  'Find someone who has built a side project',
  'Find someone who has written a CI workflow',
  'Find someone who can explain a cloud concept',
  'Find someone who has helped debug a bug',
  'Find someone who has paired on code',
  'Find someone who is new to AKWE',
  'Find someone who came from outside Cebu',
  'Find someone who has used serverless',
  'Find someone who has learned a new skill',
  'Find someone who likes terminal shortcuts',
  'Find someone who has built something for fun',
];

export function createGameSnapshot() {
  const now = '2026-09-25T01:00:00.000Z';
  return {
    game: {
      id: gameId,
      name: 'AKWE 2026 Human Bingo',
      status: 'active',
      distinctTaskCount: 25,
      taskBagLocked: true,
      stateVersion: 1,
      createdAt: now,
      updatedAt: now,
    },
    tasks: taskTexts.map((text, index) => ({
      id: `task-${index}`,
      text,
      createdAt: now,
      updatedAt: now,
    })),
    membership: {
      id: 'membership-ake-01',
      gameId,
      participantId: playerId,
      createdAt: now,
      lastSeenAt: now,
    },
    participant: { id: playerId, displayName: 'Pat', joinedAt: now },
    profile: {
      id: 'profile-ake-01',
      participantId: playerId,
      displayName: 'Pat',
      playerCode: 'P4T123',
      createdAt: now,
    },
    grid: {
      id: gridId,
      gameId,
      participantId: playerId,
      taskBagVersion: 1,
      stateVersion: 1,
      createdAt: now,
      squares: taskTexts.map((taskText, squareIndex) => ({
        gridId,
        squareIndex,
        row: Math.floor(squareIndex / 5) + 1,
        column: (squareIndex % 5) + 1,
        taskEntryId: `task-${squareIndex}`,
        taskText,
        status:
          squareIndex === 0
            ? 'verified'
            : squareIndex === 1
              ? 'pending'
              : squareIndex === 2
                ? 'rejected'
                : 'unverified',
        ...(squareIndex === 0 ? { stampIndex: 4 } : {}),
        updatedAt: now,
      })),
    },
    verificationRequests: [
      {
        id: 'request-ake-01',
        gameId,
        gridId,
        squareIndex: 1,
        taskText: taskTexts[1],
        requestingParticipant: {
          participantId: requesterId,
          displayName: 'Jo',
          playerCode: 'J01234',
        },
        identifiedParticipant: {
          participantId: playerId,
          displayName: 'Pat',
          playerCode: 'P4T123',
        },
        status: 'pending',
        createdAt: now,
      },
    ],
    notifications: [
      {
        id: 'notification-ake-01',
        gameId,
        recipientParticipantId: playerId,
        verificationRequestId: 'request-ake-01',
        kind: 'verification_request',
        status: 'pending',
        gameName: 'AKWE 2026 Human Bingo',
        requestingParticipant: {
          participantId: requesterId,
          displayName: 'Jo',
          playerCode: 'J01234',
        },
        taskText: taskTexts[1],
        createdAt: now,
      },
    ],
    leaderboards: {
      blackout: { category: 'blackout', totalCompletions: 0, entries: [] },
      line: { category: 'line', entries: [] },
      hashtag: { category: 'hashtag', totalCompletions: 0, entries: [] },
      progress: { category: 'progress', entries: [] },
    },
    stateVersion: 1,
  };
}
