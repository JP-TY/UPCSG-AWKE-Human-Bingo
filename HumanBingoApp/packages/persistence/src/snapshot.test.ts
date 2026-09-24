import { describe, expect, it } from 'vitest';
import { AuthoritativeSnapshotRebuilder, SnapshotRebuildError } from './snapshot.js';

const ids = {
  gameId: 'game-1' as never,
  membershipId: 'membership-1' as never,
  participantId: 'participant-1' as never,
};

describe('authoritative snapshot rebuild', () => {
  it('replaces disposable realtime/cache state from authoritative storage', async () => {
    const reads: string[] = [];
    let version = 1;
    const rebuilder = new AuthoritativeSnapshotRebuilder({
      readSnapshot: async (gameId, membershipId, participantId) => {
        await Promise.resolve();
        reads.push(`${gameId}:${membershipId}:${participantId}`);
        return { stateVersion: version, squares: [{ index: 0, status: 'unverified' }] };
      },
    });

    const first = await rebuilder.rebuild(ids.gameId, ids.membershipId, ids.participantId);
    version = 2;
    const second = await rebuilder.rebuild(ids.gameId, ids.membershipId, ids.participantId);

    expect(first).toEqual({ stateVersion: 1, squares: [{ index: 0, status: 'unverified' }] });
    expect(second).toEqual({ stateVersion: 2, squares: [{ index: 0, status: 'unverified' }] });
    expect(reads).toHaveLength(2);
  });

  it('surfaces a safe rebuild error when authoritative storage is unavailable', async () => {
    const rebuilder = new AuthoritativeSnapshotRebuilder({
      readSnapshot: async () => {
        await Promise.resolve();
        throw new Error('database offline');
      },
    });

    await expect(
      rebuilder.rebuild(ids.gameId, ids.membershipId, ids.participantId),
    ).rejects.toBeInstanceOf(SnapshotRebuildError);
    await expect(
      rebuilder.rebuild(ids.gameId, ids.membershipId, ids.participantId),
    ).rejects.toThrow('Authoritative snapshot rebuild failed');
  });
});
