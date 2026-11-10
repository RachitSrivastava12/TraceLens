import { randomUUID } from "node:crypto";
import type {
  Span,
  SpanType,
  Trace,
  TraceError,
  TraceIngestionPayload,
} from "@tracelens/core";

export interface TraceLensOptions {
  apiKey: string;
  endpoint?: string;
  projectId?: string;
  timeoutMs?: number;
  retries?: number;
  onIngestionError?: (error: Error) => void;
}

export interface SpanContext {
  tool<T>(name: string, fn: () => Promise<T> | T, input?: unknown): Promise<T>;
  llm<T>(name: string, fn: () => Promise<T> | T, input?: unknown): Promise<T>;
  run<T>(
    type: SpanType,
    name: string,
    fn: (span: SpanContext) => Promise<T> | T,
    input?: unknown,
  ): Promise<T>;
}

export interface TraceOptions {
  metadata?: Record<string, unknown>;
}

const DEFAULT_PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function serializeError(error: unknown): TraceError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: "Error", message: String(error) };
}

export class TraceLens {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly projectId: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly onIngestionError?: (error: Error) => void;

  constructor(options: TraceLensOptions) {
    if (!options.apiKey) throw new Error("TraceLens requires an API key.");

    this.apiKey = options.apiKey;
    this.endpoint = (options.endpoint ?? "http://localhost:4000").replace(/\/$/, "");
    this.projectId = options.projectId ?? DEFAULT_PROJECT_ID;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.retries = options.retries ?? 2;
    this.onIngestionError = options.onIngestionError;

    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1)
      throw new Error("timeoutMs must be a positive integer.");
    if (!Number.isInteger(this.retries) || this.retries < 0 || this.retries > 10)
      throw new Error("retries must be between 0 and 10.");
  }

  async trace<T>(
    name: string,
    fn: (span: SpanContext) => Promise<T> | T,
    options: TraceOptions = {},
  ): Promise<T> {
    const traceId = randomUUID();
    const startedAt = new Date();
    const spans: Span[] = [{
      id: randomUUID(),
      traceId,
      name,
      type: "agent",
      status: "running",
      startedAt: startedAt.toISOString(),
    }];

    let result!: T;
    let failed = false;
    let originalError: unknown;
    let traceStatus: Trace["status"] = "success";

    try {
      result = await fn(this.createContext(traceId, spans[0].id, spans));
      spans[0].status = "success";
    } catch (error) {
      failed = true;
      originalError = error;
      traceStatus = "error";
      spans[0].status = "error";
      spans[0].error = serializeError(error);
    }

    const endedAt = new Date();
    spans[0].endedAt = endedAt.toISOString();
    spans[0].durationMs = endedAt.getTime() - startedAt.getTime();

    const trace: Trace = {
      id: traceId,
      projectId: this.projectId,
      name,
      status: traceStatus,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAt.getTime(),
      metadata: options.metadata,
    };

    try {
      await this.ingest({ trace, spans });
    } catch (error) {
      try {
        this.onIngestionError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      } catch {
        // Telemetry hooks must never change application behavior.
      }
    }

    if (failed) throw originalError;
    return result;
  }

  private createContext(
    traceId: string,
    parentSpanId: string,
    spans: Span[],
  ): SpanContext {
    const run = async <T>(
      type: SpanType,
      name: string,
      fn: (span: SpanContext) => Promise<T> | T,
      input?: unknown,
    ): Promise<T> => {
      const startedAt = new Date();
      const span: Span = {
        id: randomUUID(),
        traceId,
        parentSpanId,
        name,
        type,
        status: "running",
        startedAt: startedAt.toISOString(),
        input,
      };
      spans.push(span);

      try {
        const output = await fn(this.createContext(traceId, span.id, spans));
        const endedAt = new Date();
        span.status = "success";
        span.output = output;
        span.endedAt = endedAt.toISOString();
        span.durationMs = endedAt.getTime() - startedAt.getTime();
        return output;
      } catch (error) {
        const endedAt = new Date();
        span.status = "error";
        span.error = serializeError(error);
        span.endedAt = endedAt.toISOString();
        span.durationMs = endedAt.getTime() - startedAt.getTime();
        throw error;
      }
    };

    return {
      run,
      tool: (name, fn, input) => run("tool", name, () => fn(), input),
      llm: (name, fn, input) => run("llm", name, () => fn(), input),
    };
  }

  private async ingest(payload: TraceIngestionPayload): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(`${this.endpoint}/v1/ingest`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (response.ok) return;

        const message = await response.text();
        const error = new Error(
          `TraceLens ingestion failed (${response.status}): ${message}`,
        );

        // Do not retry client errors such as invalid keys or invalid payloads.
        if (response.status < 500 || attempt >= this.retries) throw error;
      } catch (error) {
        if (attempt >= this.retries) throw error;
      } finally {
        clearTimeout(timeout);
      }

      await sleep(Math.min(250 * 2 ** attempt, 2_000));
    }
  }
}
