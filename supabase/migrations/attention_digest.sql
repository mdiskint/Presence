CREATE TABLE IF NOT EXISTS public.attention_digest (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT,
  digest TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  signal_count INTEGER NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attention_digest_created
  ON public.attention_digest(created_at DESC);

ALTER TABLE public.attention_digest ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS attention_digest_service_role_all ON public.attention_digest;
CREATE POLICY attention_digest_service_role_all
  ON public.attention_digest
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.cleanup_attention_digest_retention()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM public.attention_digest
  WHERE created_at < now() - INTERVAL '7 days';
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM cron.job
      WHERE jobname = 'cleanup_attention_digest_retention_hourly'
    ) THEN
      PERFORM cron.schedule(
        'cleanup_attention_digest_retention_hourly',
        '7 * * * *',
        'SELECT public.cleanup_attention_digest_retention();'
      );
    END IF;
  END IF;
END
$$;
