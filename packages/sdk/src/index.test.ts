import { afterEach, describe, expect, it, vi } from "vitest";
import { TraceLens } from "./index.js";

const API_KEY = "test_api_key_with_at_least_20_chars";

const okResponse = () => new Response("ok", { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TraceLens SDK", () => {
  it("validates constructor options", () => {
    expect(() => new TraceLens({ apiKey: "" })).toThrow("requires an API key");
    expect(() => new TraceLens({ apiKey: API_KEY, retries: -1 })).toThrow(
      "retries must be between 0 and 10",
    );
    expect(() => new TraceLens({ apiKey: API_KEY, timeoutMs: 0 })).toThrow(
      "timeoutMs must be a positive integer",
    );
  });

  it("returns application results and ingests successful traces", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const tracer = new TraceLens({
      apiKey: API_KEY,
      endpoint: "http://localhost:4000/",
    });

    await expect(
      tracer.trace("Checkout agent", async () => "paid", {
        metadata: { environment: "test" },
      }),
    ).resolves.toBe("paid");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:4000/v1/ingest");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-api-key")).toBe(API_KEY);

    const payload = JSON.parse(String(init?.body));
    expect(payload.trace).toMatchObject({
      name: "Checkout agent",
      status: "success",
      metadata: { environment: "test" },
    });
    expect(payload.spans).toHaveLength(1);
    expect(payload.spans[0]).toMatchObject({
      name: "Checkout agent",
      type: "agent",
      status: "success",
    });
  });

  it("records nested spans, inputs, outputs and parent relationships", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const tracer = new TraceLens({ apiKey: API_KEY });

    const result = await tracer.trace("Agent", async (root) =>
      root.run("chain", "Plan", async (chain) =>
        chain.tool("Search", async () => ({ hits: 3 }), { query: "refund" }),
      ),
    );

    expect(result).toEqual({ hits: 3 });
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const [root, chain, tool] = payload.spans;

    expect(root.parentSpanId).toBeUndefined();
    expect(chain.parentSpanId).toBe(root.id);
    expect(tool.parentSpanId).toBe(chain.id);
    expect(tool).toMatchObject({
      name: "Search",
      type: "tool",
      status: "success",
      input: { query: "refund" },
      output: { hits: 3 },
    });
  });

  it("captures tool failures and rethrows the original application error", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const tracer = new TraceLens({ apiKey: API_KEY });
    const failure = new Error("provider timed out");

    await expect(
      tracer.trace("Agent", (span) =>
        span.tool("LLM request", async () => {
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);

    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(payload.trace.status).toBe("error");
    expect(payload.spans[0].error.message).toBe("provider timed out");
    expect(payload.spans[1]).toMatchObject({
      name: "LLM request",
      status: "error",
      error: { name: "Error", message: "provider timed out" },
    });
  });

  it("does not let telemetry failure change application behaviour", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(
      new Error("network unavailable"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onIngestionError = vi.fn();
    const tracer = new TraceLens({
      apiKey: API_KEY,
      retries: 0,
      onIngestionError,
    });

    await expect(tracer.trace("Agent", async () => 42)).resolves.toBe(42);
    expect(onIngestionError).toHaveBeenCalledOnce();
    expect(onIngestionError.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("does not retry client errors", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("unauthorized", { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tracer = new TraceLens({ apiKey: API_KEY, retries: 3 });

    await tracer.trace("Agent", async () => "application result");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
