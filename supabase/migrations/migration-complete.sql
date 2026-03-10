-- Memory admission prerequisites: competition RPC + safety net + schema columns

ALTER TABLE public.memories
ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.memories
ADD COLUMN IF NOT EXISTS context_memories JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE OR REPLACE FUNCTION public.match_memories_for_competition(
  query_embedding vector(1536),
  p_user_id uuid DEFAULT NULL,
  similarity_threshold float DEFAULT 0.85,
  max_results int DEFAULT 8
)
RETURNS TABLE (
  id uuid,
  content text,
  similarity float,
  vitality_score float,
  pinned boolean
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    m.id,
    m.content,
    1 - (m.embedding <=> query_embedding) AS similarity,
    m.vitality_score,
    COALESCE(m.pinned, false) AS pinned
  FROM public.memories m
  WHERE m.embedding IS NOT NULL
    AND (p_user_id IS NULL OR m.user_id = p_user_id)
    AND (1 - (m.embedding <=> query_embedding)) >= similarity_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT max_results;
$$;

CREATE OR REPLACE FUNCTION public.enforce_memory_embedding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.embedding IS NULL THEN
    RAISE EXCEPTION 'embedding is required for memories inserts';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_memory_embedding ON public.memories;
CREATE TRIGGER trg_enforce_memory_embedding
BEFORE INSERT ON public.memories
FOR EACH ROW
EXECUTE FUNCTION public.enforce_memory_embedding();
