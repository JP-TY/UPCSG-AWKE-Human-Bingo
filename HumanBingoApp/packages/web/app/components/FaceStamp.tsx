import Image from 'next/image';

export const FACE_STAMPS = [
  'Chriscia',
  'Diane',
  'Irish',
  'Jasmine',
  'June',
  'Onins',
  'Ralph',
  'Suzanne',
  'Trishia',
  'Zach',
  'Zerika',
] as const;

export function FaceStamp({ stampIndex }: { stampIndex: number }) {
  const name = FACE_STAMPS[stampIndex];
  if (name === undefined) return null;

  return (
    <Image
      className={`face-stamp face-stamp--${stampIndex}`}
      src={`/brand/stamps/${name}.webp`}
      alt=""
      aria-hidden="true"
      width={72}
      height={72}
      sizes="(max-width: 40rem) 28px, 48px"
      draggable={false}
    />
  );
}
