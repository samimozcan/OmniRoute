import assert from "node:assert/strict";
import test from "node:test";
import { convertOpenAIContentToParts } from "../../open-sse/translator/helpers/geminiHelper.ts";
import { convertGeminiToInternal } from "../../src/app/api/v1beta/models/[...path]/convertGeminiToInternal.ts";
import { transformOpenAISSEToGeminiSSE } from "../../open-sse/translator/response/openai-to-gemini-sse.ts";

const uri = "https://generativelanguage.googleapis.com/v1beta/files/fixture-pdf";

test("Gemini file-id content retains its URI and PDF MIME type", () => {
  assert.deepEqual(
    convertOpenAIContentToParts([
      { type: "file", file: { file_id: uri, mime_type: "application/pdf" } },
    ]),
    [{ fileData: { fileUri: uri, mimeType: "application/pdf" } }]
  );
});

test("Gemini native fileData content is retained without treating it as image data", () => {
  assert.deepEqual(
    convertOpenAIContentToParts([{ fileData: { fileUri: uri, mimeType: "application/pdf" } }]),
    [{ fileData: { fileUri: uri, mimeType: "application/pdf" } }]
  );
});

test("native Gemini request conversion retains cachedContent and uploaded fileData", () => {
  const result = convertGeminiToInternal(
    {
      cachedContent: "cachedContents/fixture-cache",
      contents: [
        {
          role: "user",
          parts: [
            { text: "summarize" },
            { fileData: { fileUri: uri, mimeType: "application/pdf" } },
          ],
        },
      ],
    },
    "gemini/gemini-2.5-flash",
    false
  );
  assert.equal(result.cachedContent, "cachedContents/fixture-cache");
  assert.deepEqual(convertOpenAIContentToParts(result.messages[0].content), [
    { text: "summarize" },
    { fileData: { fileUri: uri, mimeType: "application/pdf" } },
  ]);
});

test("native Gemini SSE response retains the stable provider resource selection", async () => {
  const response = transformOpenAISSEToGeminiSSE(
    new Response(
      'data: {"choices":[{"delta":{"content":"fixture"},"index":0}]}\n\ndata: [DONE]\n\n',
      {
        headers: {
          "Content-Type": "text/event-stream",
          "X-OmniRoute-Provider": "gemini",
          "X-OmniRoute-Key-Index": "1",
          "X-OmniRoute-Selected-Connection-Id": "fixture-selected",
        },
      }
    ),
    "gemini/gemini-2.5-flash"
  );
  await response.text();
  assert.equal(response.headers.get("x-omniroute-provider"), "gemini");
  assert.equal(response.headers.get("x-omniroute-key-index"), "1");
  assert.equal(response.headers.get("x-omniroute-selected-connection-id"), "fixture-selected");
});
