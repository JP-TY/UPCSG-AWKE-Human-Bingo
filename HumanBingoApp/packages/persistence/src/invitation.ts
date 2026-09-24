import { randomUUID } from 'node:crypto';

import type { GameStatus } from '@human-bingo/domain';
import type { InvitationRecord, GameId, InvitationId } from './models.js';

export interface InvitationGameRecord {
  readonly id: GameId;
  readonly name: string;
  readonly status: GameStatus;
}

export interface CreateInvitationRecordInput {
  readonly id?: InvitationId;
  readonly gameId: GameId;
  readonly joinCode: string;
  readonly tokenHash: Uint8Array;
  readonly expiresAt?: Date | null;
  readonly now?: Date;
}

/**
 * Storage seam for invitation creation and public resolution. Implementations
 * must hash/compare bearer tokens without exposing the raw token and must read
 * the game status again when an onboarding transaction commits.
 */
export interface InvitationRepository {
  findGame(gameId: GameId): Promise<InvitationGameRecord | null>;
  findByGameId(gameId: GameId): Promise<InvitationRecord | null>;
  findByJoinCode(joinCode: string): Promise<InvitationRecord | null>;
  findByTokenHash(tokenHash: Uint8Array): Promise<InvitationRecord | null>;
  insert(input: CreateInvitationRecordInput): Promise<InvitationRecord>;
}

export interface InMemoryInvitationRepositoryOptions {
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

/**
 * Transaction-shaped invitation repository used by unit/property/integration
 * tests and the local application runtime. `setGame` mirrors the authoritative
 * game row after a lifecycle mutation; no membership is created by resolution.
 */
export class InMemoryInvitationRepository implements InvitationRepository {
  private readonly games = new Map<GameId, InvitationGameRecord>();
  private readonly invitationsByGame = new Map<GameId, InvitationRecord>();
  private readonly invitationsByJoinCode = new Map<string, InvitationRecord>();
  private readonly invitationsByTokenHash = new Map<string, InvitationRecord>();
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  public constructor(options: InMemoryInvitationRepositoryOptions = {}) {
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  public setGame(game: InvitationGameRecord): void {
    this.games.set(game.id, { ...game });
  }

  public findGame(gameId: GameId): Promise<InvitationGameRecord | null> {
    const game = this.games.get(gameId);
    return Promise.resolve(game === undefined ? null : { ...game });
  }

  public findByGameId(gameId: GameId): Promise<InvitationRecord | null> {
    const invitation = this.invitationsByGame.get(gameId);
    return Promise.resolve(invitation === undefined ? null : cloneInvitation(invitation));
  }

  public findByJoinCode(joinCode: string): Promise<InvitationRecord | null> {
    const invitation = this.invitationsByJoinCode.get(joinCode);
    return Promise.resolve(invitation === undefined ? null : cloneInvitation(invitation));
  }

  public findByTokenHash(tokenHash: Uint8Array): Promise<InvitationRecord | null> {
    const invitation = this.invitationsByTokenHash.get(bytesKey(tokenHash));
    return Promise.resolve(invitation === undefined ? null : cloneInvitation(invitation));
  }

  public insert(input: CreateInvitationRecordInput): Promise<InvitationRecord> {
    if (this.invitationsByGame.has(input.gameId)) {
      throw new Error(`An invitation already exists for game ${input.gameId}`);
    }
    if (this.invitationsByJoinCode.has(input.joinCode)) {
      throw new Error(`Join code ${input.joinCode} is already in use`);
    }
    const tokenKey = bytesKey(input.tokenHash);
    if (this.invitationsByTokenHash.has(tokenKey)) {
      throw new Error('Invitation token hash is already in use');
    }

    const now = new Date(input.now ?? this.now());
    const invitation: InvitationRecord = {
      id: input.id ?? (this.idFactory() as InvitationId),
      gameId: input.gameId,
      joinCode: input.joinCode,
      tokenHash: new Uint8Array(input.tokenHash),
      expiresAt:
        input.expiresAt === undefined || input.expiresAt === null
          ? null
          : new Date(input.expiresAt),
      revokedAt: null,
      createdAt: now,
    };
    this.invitationsByGame.set(invitation.gameId, invitation);
    this.invitationsByJoinCode.set(invitation.joinCode, invitation);
    this.invitationsByTokenHash.set(tokenKey, invitation);
    return Promise.resolve(cloneInvitation(invitation));
  }

  public revoke(gameId: GameId, at: Date = this.now()): void {
    const invitation = this.invitationsByGame.get(gameId);
    if (invitation === undefined) return;
    const updated: InvitationRecord = { ...invitation, revokedAt: new Date(at) };
    this.invitationsByGame.set(gameId, updated);
    this.invitationsByJoinCode.set(updated.joinCode, updated);
    this.invitationsByTokenHash.set(bytesKey(updated.tokenHash), updated);
  }
}

const bytesKey = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const cloneInvitation = (invitation: InvitationRecord): InvitationRecord => ({
  ...invitation,
  tokenHash: new Uint8Array(invitation.tokenHash),
  expiresAt: invitation.expiresAt === null ? null : new Date(invitation.expiresAt),
  revokedAt: invitation.revokedAt === null ? null : new Date(invitation.revokedAt),
  createdAt: new Date(invitation.createdAt),
});
