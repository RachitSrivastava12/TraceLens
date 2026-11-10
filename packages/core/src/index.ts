export type TraceStatus = "running" | "success" | "error";

export type SpanStatus = "running" | "success" | "error";

export type SpanType =
  | "agent"
  | "llm"
  | "tool"
  | "chain"
  | "retrieval"
  | "custom";

export interface Trace {
  id: string;
  projectId: string;
  name: string;
  status: TraceStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface Span {
  id: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  type: SpanType;
  status: SpanStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  attributes?: Record<string, unknown>;
  error?: TraceError;
}

export interface TraceError {
  name: string;
  message: string;
  stack?: string;
}

export interface TraceEvent {
  id: string;
  spanId: string;
  name: string;
  timestamp: string;
  attributes?: Record<string, unknown>;
}

export interface TraceIngestionPayload {
  trace: Trace;
  spans: Span[];
  events?: TraceEvent[];
}
