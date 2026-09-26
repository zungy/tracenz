import test from "node:test";
import assert from "node:assert/strict";
import { createSummarizer } from "../server/ai.js";
const event = {
  source: "Autodesk Fusion",
  document: { name: "Bracket", defaultLengthUnits: "mm" },
  engineeringChanges: [{ action: "feature_added", feature: { name: "Hole2" } }],
  rationale: "adding hole",
  changes: { deliberatelyNotSent: true },
};
test("OpenAI request uses normalized evidence, viewport and strict schema; rationale remains original", async () => {
  let sent;
  const summarizer = createSummarizer(
    { ai: "openai", model: "configured-model", openaiKey: "test-only" },
    async (_url, options) => {
      sent = JSON.parse(options.body);
      return Response.json({
        status: "completed",
        output: [
          {
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  title: "Added Hole2",
                  summary: "Added a hole.",
                  change_type: "feature_added",
                  rationale_used: "a paraphrase",
                  tags: ["hole"],
                  notes: [],
                }),
              },
            ],
          },
        ],
      });
    },
  );
  const result = await summarizer(event, Buffer.from("PNG test bytes"));
  assert.equal(sent.model, "configured-model");
  assert.equal(sent.store, false);
  assert.equal(sent.text.format.strict, true);
  assert.equal(
    JSON.parse(sent.input[0].content[0].text).engineeringChanges.length,
    1,
  );
  assert.equal(JSON.parse(sent.input[0].content[0].text).changes, undefined);
  assert.match(sent.input[0].content[1].image_url, /^data:image\/png;base64,/);
  assert.equal(result.ai.rationale_used, "adding hole");
  assert.equal(result.provider, "openai");
});
test("Refused, incomplete, malformed and failed AI responses never become completed summaries", async () => {
  const responses = [
    () => Response.json({ status: "incomplete", output: [] }),
    () =>
      Response.json({
        status: "completed",
        output: [{ content: [{ type: "refusal", refusal: "No" }] }],
      }),
    () =>
      Response.json({
        status: "completed",
        output: [
          {
            content: [
              { type: "output_text", text: '{"title": "only a title"}' },
            ],
          },
        ],
      }),
    () =>
      Response.json(
        { error: { message: "secret provider details" } },
        { status: 429 },
      ),
  ];
  for (const response of responses)
    await assert.rejects(
      createSummarizer({ ai: "openai" }, async () => response())(
        event,
        Buffer.from("x"),
      ),
    );
});
