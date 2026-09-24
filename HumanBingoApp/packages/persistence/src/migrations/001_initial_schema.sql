
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_account_id text NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'invitation_available', 'active', 'closed')),
  task_bag_locked_at timestamptz,
  closed_at timestamptz,
  state_version bigint NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK (task_bag_locked_at IS NULL OR status IN ('active', 'closed'))
);

CREATE TABLE task_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  display_text text NOT NULL,
  normalized_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  CHECK (display_text = btrim(display_text)),
  CHECK (length(normalized_text) > 0),
  CHECK (normalized_text = lower(btrim(normalized_text))),
  UNIQUE (game_id, id)
);
CREATE UNIQUE INDEX task_entries_active_normalized_uq ON task_entries (game_id, normalized_text) WHERE removed_at IS NULL;
CREATE INDEX task_entries_game_idx ON task_entries (game_id) WHERE removed_at IS NULL;

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL UNIQUE REFERENCES games(id) ON DELETE CASCADE,
  join_code text NOT NULL UNIQUE CHECK (join_code ~ '^[A-Z0-9]{6}$'),
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE TABLE browser_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id_hash bytea NOT NULL UNIQUE,
  account_or_guest_identity text NOT NULL,
  authorization_version bigint NOT NULL DEFAULT 0 CHECK (authorization_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX browser_sessions_identity_idx ON browser_sessions (account_or_guest_identity);

CREATE TABLE command_idempotency (
  scope_key text PRIMARY KEY,
  game_id uuid REFERENCES games(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
  command_type text NOT NULL CHECK (length(btrim(command_type)) > 0),
  state_version bigint,
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state_version IS NULL OR state_version > 0)
);
CREATE INDEX command_idempotency_game_idx ON command_idempotency (game_id, created_at);

CREATE TABLE participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  UNIQUE (game_id, id)
);
CREATE INDEX participants_game_idx ON participants (game_id);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL,
  identity_key text NOT NULL CHECK (length(btrim(identity_key)) > 0),
  browser_session_id uuid REFERENCES browser_sessions(id) ON DELETE SET NULL,
  resumable_credential_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, participant_id),
  UNIQUE (game_id, identity_key),
  FOREIGN KEY (game_id, participant_id) REFERENCES participants(game_id, id) ON DELETE CASCADE
);
CREATE INDEX memberships_session_idx ON memberships (browser_session_id);
CREATE INDEX memberships_game_idx ON memberships (game_id);

CREATE TABLE player_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL UNIQUE,
  display_name text,
  player_code text NOT NULL CHECK (length(btrim(player_code)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, participant_id),
  UNIQUE (game_id, player_code),
  FOREIGN KEY (game_id, participant_id) REFERENCES participants(game_id, id) ON DELETE CASCADE
);

CREATE TABLE grids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL,
  task_bag_version bigint NOT NULL DEFAULT 1 CHECK (task_bag_version > 0),
  state_version bigint NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, participant_id),
  UNIQUE (game_id, id),
  FOREIGN KEY (game_id, participant_id) REFERENCES participants(game_id, id) ON DELETE CASCADE
);

CREATE TABLE squares (
  grid_id uuid NOT NULL,
  game_id uuid NOT NULL,
  square_index smallint NOT NULL CHECK (square_index BETWEEN 0 AND 24),
  task_entry_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'pending', 'rejected', 'verified')),
  stamp_index smallint CONSTRAINT squares_stamp_index_range CHECK (stamp_index BETWEEN 0 AND 10),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (grid_id, square_index),
  UNIQUE (game_id, grid_id, square_index),
  UNIQUE (grid_id, task_entry_id),
  FOREIGN KEY (game_id, grid_id) REFERENCES grids(game_id, id) ON DELETE CASCADE,
  FOREIGN KEY (game_id, task_entry_id) REFERENCES task_entries(game_id, id) ON DELETE RESTRICT
);
CREATE INDEX squares_game_status_idx ON squares (game_id, status);

CREATE TABLE verification_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  grid_id uuid NOT NULL,
  square_index smallint NOT NULL CHECK (square_index BETWEEN 0 AND 24),
  requesting_participant_id uuid NOT NULL,
  identified_participant_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  outcome_actor_id uuid,
  client_command_id uuid NOT NULL UNIQUE,
  FOREIGN KEY (game_id, grid_id, square_index) REFERENCES squares(game_id, grid_id, square_index) ON DELETE CASCADE,
  FOREIGN KEY (game_id, requesting_participant_id) REFERENCES participants(game_id, id) ON DELETE CASCADE,
  FOREIGN KEY (game_id, identified_participant_id) REFERENCES participants(game_id, id) ON DELETE CASCADE,
  FOREIGN KEY (game_id, outcome_actor_id) REFERENCES participants(game_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'pending' AND resolved_at IS NULL AND outcome_actor_id IS NULL) OR
         (status IN ('confirmed', 'rejected') AND resolved_at IS NOT NULL AND outcome_actor_id IS NOT NULL)),
  CHECK (requesting_participant_id <> identified_participant_id)
);
CREATE UNIQUE INDEX verification_requests_active_square_uq ON verification_requests (game_id, grid_id, square_index) WHERE status = 'pending';
CREATE INDEX verification_requests_recipient_idx ON verification_requests (game_id, identified_participant_id, status);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  recipient_participant_id uuid NOT NULL,
  verification_request_id uuid NOT NULL REFERENCES verification_requests(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (length(btrim(kind)) > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (verification_request_id, recipient_participant_id, kind),
  FOREIGN KEY (game_id, recipient_participant_id) REFERENCES participants(game_id, id) ON DELETE CASCADE,
  CHECK ((status = 'pending' AND resolved_at IS NULL) OR (status = 'resolved' AND resolved_at IS NOT NULL))
);
CREATE INDEX notifications_pending_recipient_idx ON notifications (game_id, recipient_participant_id) WHERE status = 'pending';

CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL,
  endpoint_hash bytea NOT NULL,
  provider_data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (game_id, participant_id, endpoint_hash),
  FOREIGN KEY (game_id, participant_id) REFERENCES participants(game_id, id) ON DELETE CASCADE
);
CREATE INDEX push_subscriptions_active_idx ON push_subscriptions (game_id, participant_id) WHERE revoked_at IS NULL;

CREATE TABLE completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('blackout', 'line', 'hashtag')),
  completion_key text NOT NULL CHECK (length(btrim(completion_key)) > 0),
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, participant_id, category, completion_key),
  FOREIGN KEY (game_id, participant_id) REFERENCES participants(game_id, id) ON DELETE CASCADE,
  CHECK ((category = 'blackout' AND completion_key = 'blackout') OR
         (category = 'hashtag' AND completion_key = 'hashtag') OR
         (category = 'line' AND completion_key IN ('row:1', 'row:2', 'row:3', 'row:4', 'row:5', 'column:1', 'column:2', 'column:3', 'column:4', 'column:5', 'diag:tlbr', 'diag:trbl')))
);
CREATE INDEX completions_leaderboard_idx ON completions (game_id, category, completed_at, participant_id);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  state_version bigint NOT NULL CHECK (state_version > 0),
  event_type text NOT NULL CHECK (length(btrim(event_type)) > 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz,
  last_error text,
  UNIQUE (game_id, state_version)
);
CREATE INDEX outbox_events_pending_idx ON outbox_events (created_at, next_attempt_at) WHERE published_at IS NULL;

CREATE TABLE event_consumer_receipts (
  consumer_name text NOT NULL CHECK (length(btrim(consumer_name)) > 0),
  event_id uuid NOT NULL REFERENCES outbox_events(id) ON DELETE CASCADE,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (consumer_name, event_id)
);
CREATE INDEX event_consumer_receipts_pending_idx ON event_consumer_receipts (consumer_name, claimed_at)
  WHERE processed_at IS NULL;
