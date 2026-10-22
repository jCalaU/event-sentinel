CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY,
  phone_number_id text NOT NULL CHECK (length(phone_number_id) > 0),
  event_type text NOT NULL CHECK (event_type = 'whatsapp.message.received'),
  message_id text NOT NULL CHECK (length(message_id) > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  delivery_key text,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'completed', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz,
  lease_token uuid,
  last_error varchar(160),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT webhook_events_logical_identity UNIQUE (phone_number_id, event_type, message_id),
  CONSTRAINT webhook_events_lease_state CHECK (
    (state = 'processing' AND lease_until IS NOT NULL AND lease_token IS NOT NULL)
    OR (state <> 'processing' AND lease_until IS NULL AND lease_token IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS webhook_events_pending_idx
  ON webhook_events (phone_number_id, state, available_at)
  WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS webhook_events_lease_idx
  ON webhook_events (phone_number_id, lease_until)
  WHERE state = 'processing';
CREATE INDEX IF NOT EXISTS webhook_events_created_idx ON webhook_events (created_at);
