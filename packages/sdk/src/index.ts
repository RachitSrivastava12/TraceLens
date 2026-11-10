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
}

export interface SpanContext {
  tool<T>(
    name: string,
    fn: () => Promise<T> | T,
    input?: unknown,
  ): Promise<T>;

  llm<T>(
    name: string,
    fn: () => Promise<T> | T,
    input?: unknown,
  ): Promise<T>;

  run<T>(
    type: SpanType,
    name: string,
    fn: () => Promise<T> | T,
    input?: unknown,
  ): Promise<T>;
}

export interface TraceOptions {
  metadata?: Record<string, unknown>;
}

const DEFAULT_PROJECT_ID = "00000000-0000-4000-8000-000000000001";

function serializeError(error: unknown): TraceError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    name: "Error",
    message: String(error),
  };
}

export class TraceLens {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly projectId: string;

  constructor(options: TraceLensOptions) {
    if (!options.apiKey) {
      throw new Error("TraceLens requires an API key.");
    }

    this.apiKey = options.apiKey;
    this.endpoint = (options.endpoint ?? "http://localhost:4000").replace(/\/$/, "");
    this.projectId = options.projectId ?? DEFAULT_PROJECT_ID;
  }

  async trace<T>(
    name: string,
    fn: (span: SpanContext) => Promise<T> | T,
    options: TraceOptions = {},
  ): Promise<T> {
    const traceId = randomUUID();
    const rootSpanId = randomUUID();
    const startedAt = new Date();
    const spans: Span[] = [];

    const rootSpan: Span = {
      id: rootSpanId,
      traceId,
      name,
      type: "agent",
      status: "running",
      startedAt: startedAt.toISOString(),
    };

    spans.push(rootSpan);

    const context = this.createContext(traceId, rootSpanId, spans);

    let traceStatus: Trace["status"] = "success";
    let result: T | undefined;
    let thrownError: unknown;

    try {
      result = await fn(context);
      rootSpan.status = "success";
    } catch (error) {
      traceStatus = "error";
      rootSpan.status = "error";
      rootSpan.error = serializeError(error);
      thrownError = error;
    }

    const endedAt = new Date();
    rootSpan.endedAt = endedAt.toISOString();
    rootSpan.durationMs = endedAt.getTime() - startedAt.getTime();

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

    const payload: TraceIngestionPayload = { trace, spans };

    await this.ingest(payload);

    if (thrownError !== undefined) {
      throw thrownError;
    }

    return result as T;
  }

  private createContext(
    traceId: string,
    parentSpanId: string,
    spans: Span[],
  ): SpanContext {
    const run = async <T>(
      type: SpanType,
      name: string,
      fn: () => Promise<T> | T,
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
        const output = await fn();
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
      tool: (name, fn, input) => run("tool", name, fn, input),
      llm: (name, fn, input) => run("llm", name, fn, input),
    };
  }

  private async ingest(payload: TraceIngestionPayload): Promise<void> {
    const response = await fetch(`${this.endpoint}/v1/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(
        `TraceLens ingestion failed (${response.status}): ${message}`,
      );
    }
  }
}
