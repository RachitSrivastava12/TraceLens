import Fastify, { type FastifyRequest } from "fastify";
import { Pool } from "pg";
import { createHash } from "node:crypto";
import { z } from "zod";

const app = Fastify({ logger: true, bodyLimit: 1_048_576 });

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://tracelens:tracelens_dev@127.0.0.1:5433/tracelens",
  max: Number(process.env.PG_POOL_MAX ?? 10),
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

const DEFAULT_PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const hashKey = (key: string) =>
  createHash("sha256").update(key).digest("hex");

type AuthenticatedRequest = FastifyRequest & { projectId?: string };

const ingestionSchema = z.object({
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

function validateRelationships(payload: Ingestion): string | null {
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

async function authenticate(
  request: FastifyRequest,
  reply: import("fastify").FastifyReply,
) {
  const key = request.headers["x-api-key"];

  if (typeof key !== "string" || key.length < 20 || key.length > 512)
    return reply.code(401).send({ error: "Invalid API key" });

  const keyHash = hashKey(key);
  const result = await pool.query<{ project_id: string }>(
    `SELECT project_id FROM project_api_keys
     WHERE key_hash = $1 AND revoked_at IS NULL LIMIT 1`,
    [keyHash],
  );

  if (result.rowCount !== 1)
    return reply.code(401).send({ error: "Invalid API key" });

  (request as AuthenticatedRequest).projectId = result.rows[0].project_id;

  void pool.query(
    "UPDATE project_api_keys SET last_used_at = NOW() WHERE key_hash = $1",
    [keyHash],
  ).catch((error) =>
    request.log.warn({ err: error }, "Could not update API key last-used time"),
  );
}

function getProjectId(request: FastifyRequest): string {
  const projectId = (request as AuthenticatedRequest).projectId;
  if (!projectId) throw new Error("Authenticated project context is missing");
  return projectId;
}

app.get("/health", async (_request, reply) => {
  try {
    await pool.query("SELECT 1");
    return { status: "ok", database: "connected" };
  } catch {
    return reply.code(503).send({
      status: "error",
      database: "unavailable",
    });
  }
});

app.post("/v1/ingest", { preHandler: authenticate }, async (request, reply) => {
  const parsed = ingestionSchema.safeParse(request.body);

  if (!parsed.success)
    return reply.code(400).send({
      error: "Invalid ingestion payload",
      details: parsed.error.flatten(),
    });

  const payload = parsed.data;
  const relationshipError = validateRelationships(payload);
  if (relationshipError)
    return reply.code(400).send({ error: relationshipError });

  const projectId = getProjectId(request);
  const { trace, spans, events = [] } = payload;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const traceInsert = await client.query(
      `INSERT INTO traces
       (id, project_id, name, status, started_at, ended_at, duration_ms, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, status = EXCLUDED.status,
         ended_at = EXCLUDED.ended_at, duration_ms = EXCLUDED.duration_ms,
         metadata = EXCLUDED.metadata
       WHERE traces.project_id = EXCLUDED.project_id`,
      [
        trace.id, projectId, trace.name, trace.status, trace.startedAt,
        trace.endedAt ?? null, trace.durationMs ?? null,
        JSON.stringify(trace.metadata ?? {}),
      ],
    );

    if (traceInsert.rowCount !== 1)
      throw new Error("RESOURCE_CONFLICT");

    for (const span of spans) {
      const inserted = await client.query(
        `INSERT INTO spans
         (id, trace_id, parent_span_id, name, type, status,
          started_at, ended_at, duration_ms, input, output, attributes, error)
         VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, status = EXCLUDED.status,
           ended_at = EXCLUDED.ended_at, duration_ms = EXCLUDED.duration_ms,
           input = EXCLUDED.input, output = EXCLUDED.output,
           attributes = EXCLUDED.attributes, error = EXCLUDED.error
         WHERE spans.trace_id = EXCLUDED.trace_id`,
        [
          span.id, trace.id, span.name, span.type, span.status, span.startedAt,
          span.endedAt ?? null, span.durationMs ?? null,
          span.input === undefined ? null : JSON.stringify(span.input),
          span.output === undefined ? null : JSON.stringify(span.output),
          JSON.stringify(span.attributes ?? {}),
          span.error ? JSON.stringify(span.error) : null,
        ],
      );

      if (inserted.rowCount !== 1) throw new Error("RESOURCE_CONFLICT");
    }

    for (const span of spans) {
      const updated = await client.query(
        "UPDATE spans SET parent_span_id = $1 WHERE id = $2 AND trace_id = $3",
        [span.parentSpanId ?? null, span.id, trace.id],
      );
      if (updated.rowCount !== 1) throw new Error("SPAN_UPDATE_FAILED");
    }

    for (const event of events) {
      const inserted = await client.query(
        `INSERT INTO trace_events (id, span_id, name, timestamp, attributes)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, timestamp = EXCLUDED.timestamp,
           attributes = EXCLUDED.attributes
         WHERE trace_events.span_id = EXCLUDED.span_id`,
        [
          event.id, event.spanId, event.name, event.timestamp,
          JSON.stringify(event.attributes ?? {}),
        ],
      );
      if (inserted.rowCount !== 1) throw new Error("RESOURCE_CONFLICT");
    }

    await client.query("COMMIT");
    return {
      success: true,
      traceId: trace.id,
      spansReceived: spans.length,
      eventsReceived: events.length,
    };
  } catch (error) {
    await client.query("ROLLBACK");

    if (error instanceof Error && error.message === "RESOURCE_CONFLICT")
      return reply.code(409).send({
        error: "Resource ID is already associated with another project or trace.",
      });

    request.log.error({ err: error }, "Trace ingestion failed");
    return reply.code(500).send({ error: "Failed to store trace" });
  } finally {
    client.release();
  }
});

app.get("/v1/traces", { preHandler: authenticate }, async (request) => {
  const result = await pool.query(
    `SELECT id, name, status, started_at, ended_at, duration_ms, metadata
     FROM traces WHERE project_id = $1
     ORDER BY started_at DESC LIMIT 100`,
    [getProjectId(request)],
  );
  return { traces: result.rows };
});

app.get("/v1/traces/:id", { preHandler: authenticate }, async (request, reply) => {
  const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
  if (!params.success)
    return reply.code(400).send({ error: "Invalid trace ID" });

  const traceId = params.data.id;
  const traceResult = await pool.query(
    `SELECT id, name, status, started_at, ended_at, duration_ms, metadata
     FROM traces WHERE id = $1 AND project_id = $2`,
    [traceId, getProjectId(request)],
  );

  if (traceResult.rows.length === 0)
    return reply.code(404).send({ error: "Trace not found" });

  const [spansResult, eventsResult] = await Promise.all([
    pool.query(
      `SELECT id, trace_id, parent_span_id, name, type, status, started_at,
              ended_at, duration_ms, input, output, attributes, error
       FROM spans WHERE trace_id = $1 ORDER BY started_at ASC`,
      [traceId],
    ),
    pool.query(
      `SELECT e.id, e.span_id, e.name, e.timestamp, e.attributes
       FROM trace_events e JOIN spans s ON s.id = e.span_id
       WHERE s.trace_id = $1 ORDER BY e.timestamp ASC`,
      [traceId],
    ),
  ]);

  return {
    trace: traceResult.rows[0],
    spans: spansResult.rows,
    events: eventsResult.rows,
  };
});

async function bootstrapDevelopmentProject() {
  if (process.env.NODE_ENV === "production") return;

  const key = process.env.TRACELENS_API_KEY;
  if (!key) {
    app.log.warn("TRACELENS_API_KEY missing; development bootstrap skipped.");
    return;
  }

  const projectId = process.env.TRACELENS_PROJECT_ID ?? DEFAULT_PROJECT_ID;
  const keyHash = hashKey(key);

  await pool.query(
    `INSERT INTO projects (id, name, api_key_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [projectId, process.env.TRACELENS_PROJECT_NAME ?? "TraceLens Local", keyHash],
  );

  await pool.query(
    `INSERT INTO project_api_keys (project_id, name, key_prefix, key_hash)
     VALUES ($1, 'Development API key', $2, $3)
     ON CONFLICT (key_hash) DO NOTHING`,
    [projectId, key.slice(0, 8), keyHash],
  );
}

async function start() {
  await bootstrapDevelopmentProject();
  const port = Number(process.env.PORT ?? 4000);
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`TraceLens API listening on port ${port}`);
}

start().catch(async (error) => {
  app.log.error(error);
  await pool.end();
  process.exit(1);
});

async function shutdown(signal: string) {
  app.log.info({ signal }, "Shutting down TraceLens API");
  await app.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
