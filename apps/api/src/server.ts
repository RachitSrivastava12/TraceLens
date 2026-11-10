import Fastify from "fastify";
import { Pool } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

const app = Fastify({ logger: true });

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://tracelens:tracelens_dev@localhost:5432/tracelens",
});

const API_KEY = process.env.TRACELENS_API_KEY ?? "tl_dev_local_key";
const PROJECT_ID =
  process.env.TRACELENS_PROJECT_ID ??
  "00000000-0000-4000-8000-000000000001";

const hashKey = (key: string) =>
  createHash("sha256").update(key).digest("hex");

const ingestionSchema = z.object({
  trace: z.object({
    id: z.string().uuid(),
    name: z.string().min(1).max(500),
    status: z.enum(["running", "success", "error"]),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().optional(),
    durationMs: z.number().nonnegative().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  spans: z.array(
    z.object({
      id: z.string().uuid(),
      traceId: z.string().uuid(),
      parentSpanId: z.string().uuid().optional(),
      name: z.string().min(1).max(500),
      type: z.enum([
        "agent",
        "llm",
        "tool",
        "chain",
        "retrieval",
        "custom",
      ]),
      status: z.enum(["running", "success", "error"]),
      startedAt: z.string().datetime(),
      endedAt: z.string().datetime().optional(),
      durationMs: z.number().nonnegative().optional(),
      input: z.unknown().optional(),
      output: z.unknown().optional(),
      attributes: z.record(z.string(), z.unknown()).optional(),
      error: z
        .object({
          name: z.string(),
          message: z.string(),
          stack: z.string().optional(),
        })
        .optional(),
    }),
  ).max(1000),
  events: z.array(
    z.object({
      id: z.string().uuid(),
      spanId: z.string().uuid(),
      name: z.string(),
      timestamp: z.string().datetime(),
      attributes: z.record(z.string(), z.unknown()).optional(),
    }),
  ).max(5000).optional(),
});

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { status: "ok", database: "connected" };
});

app.post("/v1/ingest", async (request, reply) => {
  const providedKey = request.headers["x-api-key"];

  if (
    typeof providedKey !== "string" ||
    hashKey(providedKey) !== hashKey(API_KEY)
  ) {
    return reply.code(401).send({ error: "Invalid API key" });
  }

  const parsed = ingestionSchema.safeParse(request.body);

  if (!parsed.success) {
    return reply.code(400).send({
      error: "Invalid ingestion payload",
      details: parsed.error.flatten(),
    });
  }

  const { trace, spans, events = [] } = parsed.data;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO traces
       (id, project_id, name, status, started_at, ended_at, duration_ms, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         status = EXCLUDED.status,
         ended_at = EXCLUDED.ended_at,
         duration_ms = EXCLUDED.duration_ms,
         metadata = EXCLUDED.metadata`,
      [
        trace.id,
        PROJECT_ID,
        trace.name,
        trace.status,
        trace.startedAt,
        trace.endedAt ?? null,
        trace.durationMs ?? null,
        JSON.stringify(trace.metadata ?? {}),
      ],
    );

    for (const span of spans) {
      if (span.traceId !== trace.id) {
        throw new Error("A span references a different trace");
      }

      await client.query(
        `INSERT INTO spans
         (id, trace_id, parent_span_id, name, type, status,
          started_at, ended_at, duration_ms, input, output, attributes, error)
         VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           status = EXCLUDED.status,
           ended_at = EXCLUDED.ended_at,
           duration_ms = EXCLUDED.duration_ms,
           input = EXCLUDED.input,
           output = EXCLUDED.output,
           attributes = EXCLUDED.attributes,
           error = EXCLUDED.error`,
        [
          span.id,
          trace.id,
          span.name,
          span.type,
          span.status,
          span.startedAt,
          span.endedAt ?? null,
          span.durationMs ?? null,
          span.input === undefined ? null : JSON.stringify(span.input),
          span.output === undefined ? null : JSON.stringify(span.output),
          JSON.stringify(span.attributes ?? {}),
          span.error ? JSON.stringify(span.error) : null,
        ],
      );
    }

    for (const span of spans) {
      if (span.parentSpanId) {
        await client.query(
          "UPDATE spans SET parent_span_id = $1 WHERE id = $2 AND trace_id = $3",
          [span.parentSpanId, span.id, trace.id],
        );
      }
    }

    for (const event of events) {
      await client.query(
        `INSERT INTO trace_events (id, span_id, name, timestamp, attributes)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO NOTHING`,
        [
          event.id,
          event.spanId,
          event.name,
          event.timestamp,
          JSON.stringify(event.attributes ?? {}),
        ],
      );
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
    request.log.error(error);
    return reply.code(500).send({ error: "Failed to store trace" });
  } finally {
    client.release();
  }
});

app.get("/v1/traces", async (request, reply) => {
  const providedKey = request.headers["x-api-key"];

  if (
    typeof providedKey !== "string" ||
    hashKey(providedKey) !== hashKey(API_KEY)
  ) {
    return reply.code(401).send({ error: "Invalid API key" });
  }

  const result = await pool.query(
    `SELECT id, name, status, started_at, ended_at, duration_ms, metadata
     FROM traces
     WHERE project_id = $1
     ORDER BY started_at DESC
     LIMIT 100`,
    [PROJECT_ID],
  );

  return { traces: result.rows };
});


app.get("/v1/traces/:id", async (request, reply) => {
  const providedKey = request.headers["x-api-key"];

  if (
    typeof providedKey !== "string" ||
    hashKey(providedKey) !== hashKey(API_KEY)
  ) {
    return reply.code(401).send({ error: "Invalid API key" });
  }

  const { id } = request.params as { id: string };

  const traceResult = await pool.query(
    `SELECT id, name, status, started_at, ended_at, duration_ms, metadata
     FROM traces
     WHERE id = $1 AND project_id = $2`,
    [id, PROJECT_ID],
  );

  if (traceResult.rows.length === 0) {
    return reply.code(404).send({ error: "Trace not found" });
  }

  const [spansResult, eventsResult] = await Promise.all([
    pool.query(
      `SELECT id, trace_id, parent_span_id, name, type, status,
              started_at, ended_at, duration_ms, input, output,
              attributes, error
       FROM spans
       WHERE trace_id = $1
       ORDER BY started_at ASC`,
      [id],
    ),
    pool.query(
      `SELECT e.id, e.span_id, e.name, e.timestamp, e.attributes
       FROM trace_events e
       JOIN spans s ON s.id = e.span_id
       WHERE s.trace_id = $1
       ORDER BY e.timestamp ASC`,
      [id],
    ),
  ]);

  return {
    trace: traceResult.rows[0],
    spans: spansResult.rows,
    events: eventsResult.rows,
  };
});

async function start() {
  await pool.query(
    `INSERT INTO projects (id, name, api_key_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [PROJECT_ID, "TraceLens Local", hashKey(API_KEY)],
  );

  const port = Number(process.env.PORT ?? 4000);

  await app.listen({ port, host: "0.0.0.0" });

  app.log.info(`TraceLens API listening on port ${port}`);
}

start().catch(async (error) => {
  app.log.error(error);
  await pool.end();
  process.exit(1);
});

process.on("SIGINT", async () => {
  await app.close();
  await pool.end();
  process.exit(0);
});
