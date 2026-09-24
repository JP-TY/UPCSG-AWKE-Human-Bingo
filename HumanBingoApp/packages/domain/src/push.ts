import type { GameId, VerificationRequestId } from './contracts.js';

/**
 * The only data allowed in a browser push notification. Credentials and raw
 * invitation/session values are deliberately not representable here.
 */
export interface VerificationPushPayload {
  readonly gameName: string;
  readonly requestingParticipant: string;
  readonly taskText: string;
  readonly deepLink: string;
}

export interface VerificationPushPayloadInput {
  readonly appOrigin: string;
  readonly gameId: GameId;
  readonly verificationRequestId: VerificationRequestId;
  readonly gameName: string;
  readonly requestingParticipant: string;
  readonly taskText: string;
}

/**
 * Builds an origin-scoped deep link for a pending verification request. The
 * route contains only opaque public identifiers; no session, invitation, or
 * push credential is copied into the payload.
 */
export function createVerificationPushPayload(
  input: VerificationPushPayloadInput,
): VerificationPushPayload {
  const origin = parseApplicationOrigin(input.appOrigin);
  const gameId = encodePathSegment(String(input.gameId));
  const requestId = String(input.verificationRequestId);
  const deepLink = new URL(`/game/${gameId}/notifications`, origin);
  deepLink.searchParams.set('request', requestId);

  return {
    gameName: nonEmptyText(input.gameName, 'game name'),
    requestingParticipant: nonEmptyText(input.requestingParticipant, 'requesting participant'),
    taskText: nonEmptyText(input.taskText, 'task text'),
    deepLink: deepLink.toString(),
  };
}

export function isSafeVerificationPushPayload(
  value: unknown,
  appOrigin: string,
): value is VerificationPushPayload {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.gameName !== 'string' ||
    typeof candidate.requestingParticipant !== 'string' ||
    typeof candidate.taskText !== 'string' ||
    typeof candidate.deepLink !== 'string'
  ) {
    return false;
  }
  if (
    candidate.gameName.trim().length === 0 ||
    candidate.requestingParticipant.trim().length === 0 ||
    candidate.taskText.trim().length === 0
  ) {
    return false;
  }

  try {
    const allowedOrigin = parseApplicationOrigin(appOrigin);
    const link = new URL(candidate.deepLink);
    return (
      link.origin === allowedOrigin.origin &&
      /^\/game\/[^/]+\/notifications$/.test(link.pathname) &&
      link.searchParams.has('request') &&
      link.searchParams.get('request')?.trim().length !== 0 &&
      [...link.searchParams.keys()].every((key) => key === 'request') &&
      link.hash === ''
    );
  } catch {
    return false;
  }
}

function parseApplicationOrigin(value: string): URL {
  const origin = new URL(value);
  if (
    origin.username !== '' ||
    origin.password !== '' ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== ''
  ) {
    throw new TypeError('The application origin must not include credentials or a path');
  }
  if (
    origin.protocol !== 'https:' &&
    origin.hostname !== 'localhost' &&
    origin.hostname !== '127.0.0.1'
  ) {
    throw new TypeError('The application origin must use HTTPS');
  }
  origin.pathname = '/';
  origin.search = '';
  origin.hash = '';
  return origin;
}

function encodePathSegment(value: string): string {
  if (value.length === 0 || value.includes('/') || value.includes('\\')) {
    throw new TypeError('The game identifier is invalid');
  }
  return encodeURIComponent(value);
}

function nonEmptyText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`The ${label} is required`);
  return normalized;
}
