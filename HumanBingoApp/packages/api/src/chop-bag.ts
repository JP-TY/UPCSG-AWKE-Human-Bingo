import { createHash } from 'node:crypto';

export const FACE_STAMP_COUNT = 11;

/**
 * Returns the face dealt to a verified square. Each grid gets an independent,
 * deterministic shuffle per 11-face bag, so the database only needs to persist
 * the chosen index on the square. A reconnect or retry therefore cannot redraw
 * a different face.
 */
export function faceStampIndexFor(gridId: string, verifiedOrdinal: number): number {
  if (gridId.trim().length === 0) throw new RangeError('gridId must not be empty');
  if (!Number.isSafeInteger(verifiedOrdinal) || verifiedOrdinal < 0) {
    throw new RangeError('verifiedOrdinal must be a non-negative safe integer');
  }

  const bagRound = Math.floor(verifiedOrdinal / FACE_STAMP_COUNT);
  const position = verifiedOrdinal % FACE_STAMP_COUNT;
  return createFaceStampBag(gridId, bagRound)[position]!;
}

function createFaceStampBag(gridId: string, bagRound: number): number[] {
  const bag = Array.from({ length: FACE_STAMP_COUNT }, (_, index) => index);
  for (let index = bag.length - 1; index > 0; index -= 1) {
    const digest = createHash('sha256')
      .update(`${gridId}:akwe-face-bag:${bagRound}:${index}`)
      .digest();
    const swapIndex = digest.readUInt32BE(0) % (index + 1);
    [bag[index], bag[swapIndex]] = [bag[swapIndex]!, bag[index]!];
  }
  return bag;
}
