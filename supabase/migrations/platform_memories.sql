CREATE TABLE IF NOT EXISTS public.platform_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL,
  content text NOT NULL,
  content_hash text NOT NULL UNIQUE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz NULL,
  user_id uuid NULL
);

CREATE INDEX IF NOT EXISTS idx_platform_memories_content_hash
  ON public.platform_memories (content_hash);

CREATE INDEX IF NOT EXISTS idx_platform_memories_platform_active
  ON public.platform_memories (platform, removed_at)
  WHERE removed_at IS NULL;

ALTER TABLE public.platform_memories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_memories_service_role_all ON public.platform_memories;
CREATE POLICY platform_memories_service_role_all
  ON public.platform_memories
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

