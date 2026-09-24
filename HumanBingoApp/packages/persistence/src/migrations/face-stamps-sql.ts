export const faceStampsUpSql = String.raw`
ALTER TABLE squares
  ADD COLUMN IF NOT EXISTS stamp_index smallint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'squares_stamp_index_range'
       AND conrelid = 'squares'::regclass
  ) THEN
    ALTER TABLE squares
      ADD CONSTRAINT squares_stamp_index_range
      CHECK (stamp_index BETWEEN 0 AND 10);
  END IF;
END
$$;

WITH verified_ordinals AS (
  SELECT grid_id,
         square_index,
         row_number() OVER (PARTITION BY grid_id ORDER BY updated_at, square_index) - 1 AS ordinal
    FROM squares
   WHERE status = 'verified'
), rounds AS (
  SELECT DISTINCT grid_id, (ordinal / 11)::integer AS bag_round
    FROM verified_ordinals
), shuffled_faces AS (
  SELECT rounds.grid_id,
         rounds.bag_round,
         faces.face_index,
         row_number() OVER (
           PARTITION BY rounds.grid_id, rounds.bag_round
           ORDER BY md5(rounds.grid_id::text || ':' || rounds.bag_round::text || ':' || faces.face_index::text)
         ) - 1 AS bag_position
    FROM rounds
    CROSS JOIN generate_series(0, 10) AS faces(face_index)
)
UPDATE squares AS target
   SET stamp_index = shuffled_faces.face_index::smallint
  FROM verified_ordinals
  JOIN shuffled_faces
    ON shuffled_faces.grid_id = verified_ordinals.grid_id
   AND shuffled_faces.bag_round = (verified_ordinals.ordinal / 11)::integer
   AND shuffled_faces.bag_position = verified_ordinals.ordinal % 11
 WHERE target.grid_id = verified_ordinals.grid_id
   AND target.square_index = verified_ordinals.square_index
   AND target.stamp_index IS NULL;
`;

export const faceStampsDownSql = String.raw`
ALTER TABLE squares
  DROP CONSTRAINT IF EXISTS squares_stamp_index_range;

ALTER TABLE squares
  DROP COLUMN IF EXISTS stamp_index;
`;
