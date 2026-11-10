import { TraceLens } from "@tracelens/sdk";

const tracer = new TraceLens({
  apiKey: "tl_dev_local_key",
  endpoint: "http://localhost:4000",
});

async function main() {
  try {
    await tracer.trace(
      "Customer Support Agent",
      async (span) => {
        console.log("Agent started");

        const result = await span.tool(
          "Search Knowledge Base",
          async () => {
            console.log("Searching knowledge base...");
            await new Promise((resolve) => setTimeout(resolve, 1200));

            throw new Error("Knowledge base request timed out");
          },
          { query: "refund policy" },
        );

        console.log("Search result:", result);
      },
      {
        metadata: {
          environment: "development",
          example: "basic-agent",
        },
      },
    );
  } catch (error) {
    console.error("Agent failed:", error);
  }
}

main().catch(console.error);
