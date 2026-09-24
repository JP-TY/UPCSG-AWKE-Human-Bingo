import type { GameId, MembershipId, ParticipantId } from '@human-bingo/domain';

/** The authoritative source is intentionally queried on every rebuild. */
export interface AuthoritativeSnapshotReader<Snapshot> {
  readonly readSnapshot: (
    gameId: GameId,
    membershipId: MembershipId,
    participantId: ParticipantId,
  ) => Promise<Snapshot>;
}

export class SnapshotRebuildError extends Error {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'SnapshotRebuildError';
  }
}

export class AuthoritativeSnapshotRebuilder<Snapshot> {
  public constructor(private readonly reader: AuthoritativeSnapshotReader<Snapshot>) {}

  /**
   * Rebuilds a view after a reconnect, event gap, or broker outage. No local
   * event/cache state is consulted, so the result can recover from a disposable
   * broker or stale browser cache.
   */
  public async rebuild(
    gameId: GameId,
    membershipId: MembershipId,
    participantId: ParticipantId,
  ): Promise<Snapshot> {
    try {
      return await this.reader.readSnapshot(gameId, membershipId, participantId);
    } catch (error: unknown) {
      throw new SnapshotRebuildError('Authoritative snapshot rebuild failed', { cause: error });
    }
  }
}
