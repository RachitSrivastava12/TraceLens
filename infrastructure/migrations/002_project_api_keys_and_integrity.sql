BEGIN;

-- Support multiple independently revocable API keys per project.
CREATE TABLE IF NOT EXISTS project_api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_project_api_keys_project
    ON project_api_keys(project_id);

CREATE INDEX IF NOT EXISTS idx_project_api_keys_active
    ON project_api_keys(key_hash)
    WHERE revoked_at IS NULL;

-- Preserve existing project credentials during migration.
INSERT INTO project_api_keys (project_id, name, key_prefix, key_hash)
SELECT id, 'Legacy API key', 'legacy', api_key_hash
FROM projects
WHERE api_key_hash IS NOT NULL
ON CONFLICT (key_hash) DO NOTHING;

-- Prevent a span from referencing a parent in another trace.
CREATE OR REPLACE FUNCTION enforce_same_trace_parent()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.parent_span_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM spans parent
        WHERE parent.id = NEW.parent_span_id
          AND parent.trace_id = NEW.trace_id
    ) THEN
        RAISE EXCEPTION 'Parent span must belong to the same trace'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS spans_same_trace_parent ON spans;

CREATE TRIGGER spans_same_trace_parent
BEFORE INSERT OR UPDATE OF trace_id, parent_span_id
ON spans
FOR EACH ROW
EXECUTE FUNCTION enforce_same_trace_parent();

COMMIT;
