import { describe, expect, it } from "vitest";
import { ingestionSchema, validateRelationships } from "./validation.js";

const traceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const rootId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const childId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const eventId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const timestamp = "2026-11-11T00:00:00.000Z";

function payload() {
  return {
    trace: {
      id: traceId,
      name: "Test agent",
      status: "success" as const,
      startedAt: timestamp,
      endedAt: timestamp,
      durationMs: 12,
    },
    spans: [
      {
        id: rootId,
        traceId,
        name: "Root",
        type: "agent" as const,
        status: "success" as const,
        startedAt: timestamp,
      },
      {
        id: childId,
        traceId,
        parentSpanId: rootId,
        name: "Child tool",
        type: "tool" as const,
        status: "success" as const,
        startedAt: timestamp,
        input: { query: "refund" },
      },
    ],
    events: [
      {
        id: eventId,
        spanId: childId,
        name: "tool.completed",
        timestamp,
      },
    ],
  };
}

describe("API ingestion validation", () => {
  it("accepts a valid trace, span hierarchy and event", () => {
    const parsed = ingestionSchema.safeParse(payload());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(validateRelationships(parsed.data)).toBeNull();
    }
  });

  it("rejects malformed trace IDs and invalid span types", () => {
    const invalidId = payload();
    invalidId.trace.id = "not-a-uuid";
    expect(ingestionSchema.safeParse(invalidId).success).toBe(false);

    const invalidType = payload();
    invalidType.spans[1].type = "made-up" as never;
    expect(ingestionSchema.safeParse(invalidType).success).toBe(false);
  });

  it("rejects spans belonging to another trace", () => {
    const data = payload();
    data.spans[1].traceId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    expect(validateRelationships(data)).toBe(
      "Every span must belong to the submitted trace.",
    );
  });

  it("rejects duplicate span IDs", () => {
    const data = payload();
    data.spans[1].id = rootId;
    expect(validateRelationships(data)).toBe(
      "Duplicate span IDs are not allowed.",
    );
  });

  it("rejects missing parents and self-parent relationships", () => {
    const missingParent = payload();
    missingParent.spans[1].parentSpanId =
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    expect(validateRelationships(missingParent)).toBe(
      "Every parent span must be included in the same ingestion payload.",
    );

    const selfParent = payload();
    selfParent.spans[1].parentSpanId = childId;
    expect(validateRelationships(selfParent)).toBe(
      "A span cannot be its own parent.",
    );
  });

  it("rejects cyclic span relationships", () => {
    const data = payload();
    data.spans[0].parentSpanId = childId;
    expect(validateRelationships(data)).toBe(
      "Span parent relationships cannot contain cycles.",
    );
  });

  it("rejects events that reference unknown spans", () => {
    const data = payload();
    data.events[0].spanId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    expect(validateRelationships(data)).toBe(
      "Every event must reference a span in the submitted trace.",
    );
  });

  it("rejects duplicate event IDs", () => {
    const data = payload();
    data.events.push({ ...data.events[0] });
    expect(validateRelationships(data)).toBe(
      "Duplicate event IDs are not allowed.",
    );
  });
});
