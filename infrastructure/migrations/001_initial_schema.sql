CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    api_key_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE traces (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    external_trace_id TEXT,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    duration_ms BIGINT,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_traces_project_started
ON traces(project_id, started_at DESC);

CREATE TABLE spans (
    id UUID PRIMARY KEY,
    trace_id UUID NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
    parent_span_id UUID REFERENCES spans(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    duration_ms BIGINT,
    input JSONB,
    output JSONB,
    attributes JSONB NOT NULL DEFAULT '{}',
    error JSONB
);

CREATE INDEX idx_spans_trace ON spans(trace_id);
CREATE INDEX idx_spans_parent ON spans(parent_span_id);

CREATE TABLE trace_events (
    id UUID PRIMARY KEY,
    span_id UUID NOT NULL REFERENCES spans(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    attributes JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_events_span ON trace_events(span_id);
