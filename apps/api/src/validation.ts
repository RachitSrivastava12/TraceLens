import { z } from "zod";

export const ingestionSchema = z.object({
  trace: z.object({
    id: z.string().uuid(),
    name: z.string().min(1).max(500),
    status: z.enum(["running", "success", "error"]),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().optional(),
    durationMs: z.number().finite().nonnegative().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  spans: z.array(z.object({
    id: z.string().uuid(),
    traceId: z.string().uuid(),
    parentSpanId: z.string().uuid().optional(),
    name: z.string().min(1).max(500),
    type: z.enum(["agent", "llm", "tool", "chain", "retrieval", "custom"]),
    status: z.enum(["running", "success", "error"]),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().optional(),
    durationMs: z.number().finite().nonnegative().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
    error: z.object({
      name: z.string().max(200),
      message: z.string().max(10_000),
      stack: z.string().max(50_000).optional(),
    }).optional(),
  })).max(1000),
  events: z.array(z.object({
    id: z.string().uuid(),
    spanId: z.string().uuid(),
    name: z.string().min(1).max(500),
    timestamp: z.string().datetime(),
    attributes: z.record(z.string(), z.unknown()).optional(),
  })).max(5000).optional(),
});

type Ingestion = z.infer<typeof ingestionSchema>;

export function validateRelationships(payload: Ingestion): string | null {
  const spanIds = new Set<string>();

  for (const span of payload.spans) {
    if (span.traceId !== payload.trace.id)
      return "Every span must belong to the submitted trace.";
    if (spanIds.has(span.id)) return "Duplicate span IDs are not allowed.";
    spanIds.add(span.id);
  }

  const parents = new Map<string, string>();
  for (const span of payload.spans) {
    if (!span.parentSpanId) continue;
    if (span.parentSpanId === span.id)
      return "A span cannot be its own parent.";
    if (!spanIds.has(span.parentSpanId))
      return "Every parent span must be included in the same ingestion payload.";
    parents.set(span.id, span.parentSpanId);
  }

  for (const id of spanIds) {
    const visited = new Set<string>();
    let current: string | undefined = id;
    while (current) {
      if (visited.has(current))
        return "Span parent relationships cannot contain cycles.";
      visited.add(current);
      current = parents.get(current);
    }
  }

  const eventIds = new Set<string>();
  for (const event of payload.events ?? []) {
    if (!spanIds.has(event.spanId))
      return "Every event must reference a span in the submitted trace.";
    if (eventIds.has(event.id)) return "Duplicate event IDs are not allowed.";
    eventIds.add(event.id);
  }

  return null;
}
