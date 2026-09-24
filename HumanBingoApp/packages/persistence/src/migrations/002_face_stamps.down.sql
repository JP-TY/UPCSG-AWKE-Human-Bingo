ALTER TABLE squares
  DROP CONSTRAINT IF EXISTS squares_stamp_index_range;

ALTER TABLE squares
  DROP COLUMN IF EXISTS stamp_index;
