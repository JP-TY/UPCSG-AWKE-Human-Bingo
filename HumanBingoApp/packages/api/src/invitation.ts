import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  DomainErrorCode,
  GameStatus,
  HumanBingoError,
  InvitationStatus,
  type CorrelationId,
  type CreateInvitationCommand,
  type CreateInvitationResult,
  type InvitationInput,
  type InvitationPreviewDto,
  type InvitationRepresentationDto,
  type InvitationToken,
  type JoinCode,
  type ResolveInvitationResult,
  type Timestamp,
} from '@human-bingo/domain';
import type { InvitationGameRecord, InvitationRepository } from '@human-bingo/persistence';

const JOIN_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const INVITATION_TOKEN_BYTES = 32;
const DEFAULT_CANONICAL_BASE_URL = 'https://app.example';

export interface InvitationServiceOptions {
  readonly canonicalBaseUrl?: string;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  /** Injectable only for deterministic tests; production uses node:crypto. */
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly randomInt?: (maxExclusive: number) => number;
  readonly expiresAt?: Date | null;
}

/**
 * The invitation application seam. Public resolution only reads the invitation
 * and current game row; onboarding must call assertUsableForOnboarding again
 * inside its membership commit transaction.
 */
export class InvitationService {
  private readonly canonicalBaseUrl: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly randomInt: (maxExclusive: number) => number;
  private readonly invitationExpiresAt: Date | null;
  private readonly rawTokens = new Map<string, InvitationToken>();

  public constructor(
    private readonly repository: InvitationRepository,
    options: InvitationServiceOptions = {},
  ) {
    this.canonicalBaseUrl = normalizeBaseUrl(
      options.canonicalBaseUrl ?? DEFAULT_CANONICAL_BASE_URL,
    );
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.randomBytes = options.randomBytes ?? ((size) => new Uint8Array(randomBytes(size)));
    this.randomInt = options.randomInt ?? ((maxExclusive) => randomInt(maxExclusive));
    this.invitationExpiresAt =
      options.expiresAt === undefined || options.expiresAt === null
        ? null
        : new Date(options.expiresAt);
  }

  public async create(
    command: CreateInvitationCommand,
    options?: { readonly canonicalBaseUrl?: string },
  ): Promise<CreateInvitationResult> {
    const canonicalBaseUrl =
      options?.canonicalBaseUrl === undefined
        ? this.canonicalBaseUrl
        : normalizeBaseUrl(options.canonicalBaseUrl);
    const game = await this.repository.findGame(command.gameId);
    assertJoinableGame(game, command.correlationId);
    if (game === null) throw invitationInvalid(command.correlationId);

    const existing = await this.repository.findByGameId(command.gameId);
    if (existing !== null) {
      const token = this.rawTokens.get(String(command.gameId));
      if (token === undefined) {
        throw new HumanBingoError({
          code: DomainErrorCode.OnboardingRetryable,
          message: 'The invitation representation is unavailable. Please retry.',
          correlationId: command.correlationId,
          retryable: true,
          httpStatus: 503,
        });
      }
      return {
        invitation: toRepresentation(existing, game, canonicalBaseUrl, token, this.now()),
      };
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const invitationToken = this.randomBytes(INVITATION_TOKEN_BYTES);
      const token = toBase64Url(invitationToken) as InvitationToken;
      try {
        const record = await this.repository.insert({
          id: this.idFactory() as never,
          gameId: command.gameId,
          joinCode: generateJoinCode(this.randomInt),
          tokenHash: hashToken(token),
          expiresAt: this.invitationExpiresAt,
          now: this.now(),
        });
        this.rawTokens.set(String(command.gameId), token);
        return {
          invitation: toRepresentation(record, game, canonicalBaseUrl, token, this.now()),
        };
      } catch (error: unknown) {
        lastError = error;
        // A unique collision is safe to retry. Other persistence failures are
        // surfaced rather than accidentally creating a second representation.
        if (!isUniqueCollision(error)) throw error;
      }
    }

    throw new HumanBingoError({
      code: DomainErrorCode.OnboardingRetryable,
      message: 'The invitation could not be created. Please retry.',
      correlationId: command.correlationId,
      retryable: true,
      httpStatus: 503,
      metadata: { ...(lastError instanceof Error ? { cause: lastError.message } : {}) },
    });
  }

  public async resolve(input: {
    readonly correlationId: CorrelationId;
    readonly input: InvitationInput;
  }): Promise<ResolveInvitationResult> {
    const invitation = await this.findInvitation(input.input);
    if (invitation === null) throw invitationInvalid(input.correlationId);

    const game = await this.repository.findGame(invitation.gameId);
    assertResolvable(game, invitation, this.now(), input.correlationId);
    if (game === null) throw invitationInvalid(input.correlationId);
    return { preview: toPreview(game, invitation, InvitationStatus.Available) };
  }

  /**
   * Repeats resolution checks for the onboarding commit. This method performs
   * no membership writes and is intentionally separate from public preview
   * resolution so callers can invoke it after acquiring their transaction lock.
   */
  public async assertUsableForOnboarding(input: {
    readonly correlationId: CorrelationId;
    readonly gameId: InvitationGameRecord['id'];
    readonly invitation: InvitationInput;
  }): Promise<void> {
    const invitation = await this.findInvitation(input.invitation);
    if (invitation === null || invitation.gameId !== input.gameId) {
      throw invitationInvalid(input.correlationId);
    }
    const game = await this.repository.findGame(input.gameId);
    assertResolvable(game, invitation, this.now(), input.correlationId);
  }

  public async resolveQr(input: {
    readonly correlationId: CorrelationId;
    readonly qrPayload: string;
  }): Promise<ResolveInvitationResult> {
    let link: string;
    try {
      link = decodeQrPayload(input.qrPayload);
    } catch {
      throw invitationInvalid(input.correlationId);
    }
    const token = tokenFromCanonicalLink(link);
    return this.resolve({ correlationId: input.correlationId, input: { token } });
  }

  private async findInvitation(input: InvitationInput) {
    if ('joinCode' in input) {
      if (!/^[A-Z0-9]{6}$/.test(input.joinCode)) return null;
      return this.repository.findByJoinCode(input.joinCode);
    }
    if (!isSafeToken(input.token)) return null;
    const expectedHash = hashToken(input.token);
    const invitation = await this.repository.findByTokenHash(expectedHash);
    if (invitation === null || invitation.tokenHash.length !== expectedHash.length) return null;
    return timingSafeEqual(invitation.tokenHash, expectedHash) ? invitation : null;
  }
}

export const generateJoinCode = (
  nextInt: (maxExclusive: number) => number = (maxExclusive) => randomInt(maxExclusive),
): JoinCode => {
  let value = '';
  for (let index = 0; index < 6; index += 1) {
    value += JOIN_CODE_ALPHABET[nextInt(JOIN_CODE_ALPHABET.length)] ?? '';
  }
  return value as JoinCode;
};

export const hashInvitationToken = (token: InvitationToken): Uint8Array => hashToken(token);

/** Encodes the canonical link carried by the QR presentation. */
export const encodeQrPayload = (canonicalLink: string): string =>
  `hbqr1.${Buffer.from(canonicalLink, 'utf8').toString('base64url')}`;

export const decodeQrPayload = (payload: string): string => {
  if (!payload.startsWith('hbqr1.')) throw new Error('Invalid Human Bingo QR payload');
  const encoded = payload.slice('hbqr1.'.length);
  if (encoded.length === 0 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('Invalid Human Bingo QR payload');
  }
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  const parsed = new URL(decoded);
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.pathname.split('/').filter(Boolean).length !== 2
  ) {
    throw new Error('Invalid Human Bingo invitation link');
  }
  return parsed.toString();
};

export const tokenFromCanonicalLink = (canonicalLink: string): InvitationToken => {
  const parsed = new URL(canonicalLink);
  const parts = parsed.pathname.split('/').filter(Boolean);
  const token = parts[1];
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parts.length !== 2 ||
    parts[0] !== 'invite' ||
    token === undefined ||
    !isSafeToken(token)
  ) {
    throw new Error('Invalid Human Bingo invitation link');
  }
  return token as InvitationToken;
};

const toRepresentation = (
  invitation: {
    readonly id: string;
    readonly gameId: InvitationGameRecord['id'];
    readonly joinCode: string;
    readonly expiresAt: Date | null;
    readonly revokedAt: Date | null;
  },
  game: InvitationGameRecord,
  canonicalBaseUrl: string,
  token: InvitationToken,
  now: Date,
): InvitationRepresentationDto => {
  const canonicalLink = `${canonicalBaseUrl}/invite/${encodeURIComponent(token)}`;
  return {
    invitationId: invitation.id as never,
    gameId: invitation.gameId,
    joinCode: invitation.joinCode as JoinCode,
    canonicalLink,
    qrPayload: encodeQrPayload(canonicalLink),
    status: invitationStatus(game, invitation, now),
    ...(invitation.expiresAt === null ? {} : { expiresAt: timestamp(invitation.expiresAt) }),
  };
};

const invitationStatus = (
  game: InvitationGameRecord,
  invitation: { readonly expiresAt: Date | null; readonly revokedAt: Date | null },
  now: Date,
): InvitationStatus => {
  if (game.status === GameStatus.Closed) return InvitationStatus.Closed;
  if (invitation.revokedAt !== null) return InvitationStatus.Revoked;
  if (invitation.expiresAt !== null && now.getTime() >= invitation.expiresAt.getTime()) {
    return InvitationStatus.Expired;
  }
  return InvitationStatus.Available;
};

const toPreview = (
  game: InvitationGameRecord,
  invitation: { readonly joinCode: string; readonly expiresAt: Date | null },
  invitationStatus: InvitationStatus,
): InvitationPreviewDto => ({
  gameId: game.id,
  gameName: game.name,
  gameStatus: game.status,
  invitationStatus,
  joinCode: invitation.joinCode as JoinCode,
  ...(invitation.expiresAt === null ? {} : { expiresAt: timestamp(invitation.expiresAt) }),
});

const assertJoinableGame = (
  game: InvitationGameRecord | null,
  correlationId: CorrelationId,
): void => {
  if (game?.status === GameStatus.Closed) throw invitationClosed(correlationId);
  if (
    game === null ||
    (game.status !== GameStatus.InvitationAvailable && game.status !== GameStatus.Active)
  ) {
    throw invitationInvalid(correlationId);
  }
};

const assertResolvable = (
  game: InvitationGameRecord | null,
  invitation: { readonly expiresAt: Date | null; readonly revokedAt: Date | null },
  now: Date,
  correlationId: CorrelationId,
): void => {
  if (game?.status === GameStatus.Closed) throw invitationClosed(correlationId);
  if (
    game === null ||
    (game.status !== GameStatus.InvitationAvailable && game.status !== GameStatus.Active) ||
    invitation.revokedAt !== null
  ) {
    throw invitationInvalid(correlationId);
  }
  if (invitation.expiresAt !== null && now.getTime() >= invitation.expiresAt.getTime()) {
    throw invitationInvalid(correlationId);
  }
};

const invitationInvalid = (correlationId: CorrelationId): HumanBingoError =>
  new HumanBingoError({
    code: DomainErrorCode.InvitationInvalid,
    message: 'The invitation is invalid, expired, or revoked.',
    correlationId,
    retryable: false,
    httpStatus: 404,
  });

const invitationClosed = (correlationId: CorrelationId): HumanBingoError =>
  new HumanBingoError({
    code: DomainErrorCode.InvitationClosed,
    message: 'This Human Bingo game is no longer accepting participants.',
    correlationId,
    retryable: false,
    httpStatus: 404,
  });

const hashToken = (token: InvitationToken): Uint8Array =>
  new Uint8Array(createHash('sha256').update(token, 'utf8').digest());

const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

const isSafeToken = (token: string): boolean =>
  token.length >= 32 && token.length <= 128 && /^[A-Za-z0-9_-]+$/.test(token);

const timestamp = (value: Date): Timestamp => value.toISOString() as Timestamp;

const normalizeBaseUrl = (value: string): string => {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Invitation canonical base URL must be an HTTP or HTTPS URL');
  }
  return parsed.toString().replace(/\/$/, '');
};

const isUniqueCollision = (error: unknown): boolean =>
  error instanceof Error && /already in use|unique|duplicate/i.test(error.message);

void timingSafeEqual;
