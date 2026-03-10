CREATE TABLE IF NOT EXISTS presence_gate (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL CHECK (status IN ('accumulating', 'fired', 'suppressed')),
  signal_count int,
  burst_detected boolean DEFAULT false,
  last_signal_at timestamptz,
  last_fire_at timestamptz,
  detail text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_presence_gate_status ON presence_gate(status, created_at DESC);

ALTER TABLE presence_gate ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS presence_gate_service ON presence_gate;
CREATE POLICY presence_gate_service ON presence_gate FOR ALL USING (true);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION notify_presence_gatekeeper()
      RETURNS trigger AS $inner$
      BEGIN
        PERFORM net.http_post(
          url := current_setting('app.settings.supabase_functions_url') || '/presence-gatekeeper',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
            'Content-Type', 'application/json'
          ),
          body := jsonb_build_object(
            'signal_id', NEW.id,
            'signal_type', NEW.signal_type,
            'created_at', NEW.created_at
          )
        );
        RETURN NEW;
      END;
      $inner$ LANGUAGE plpgsql;
    $fn$;

    IF EXISTS (
      SELECT 1
      FROM pg_trigger
      WHERE tgname = 'activity_signal_gatekeeper'
    ) THEN
      DROP TRIGGER activity_signal_gatekeeper ON activity_signal;
    END IF;

    CREATE TRIGGER activity_signal_gatekeeper
    AFTER INSERT ON activity_signal
    FOR EACH ROW EXECUTE FUNCTION notify_presence_gatekeeper();
  ELSE
    RAISE NOTICE 'pg_net extension not available. Configure a Supabase Database Webhook for activity_signal INSERT to /functions/v1/presence-gatekeeper.';
  END IF;
END
$$;

