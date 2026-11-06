import assert from "node:assert/strict";
import test from "node:test";
import { runProviderExecutionPipeline } from "../../open-sse/handlers/chatCore/providerExecutionPipeline.ts";
import { updateFromHeaders } from "../../open-sse/services/rateLimitManager.ts";
import { getOpenAIRateLimitObservations } from "../../open-sse/services/usage/openaiRateLimits.ts";

for (const targetFormat of ["openai", "openai-responses"]) {
  for (const stream of [false, true]) {
    for (const status of [200, 429]) {
      test(`native ${targetFormat} ${stream ? "stream" : "JSON"} status ${status} captures headers without consuming success body`, async () => {
        const connectionId = `openai-pipeline-${targetFormat}-${stream}-${status}`;
        const response = new Response(
          status === 200
            ? "payload-stays-readable"
            : JSON.stringify({ error: { message: "rate limit" } }),
          {
            status,
            headers: { "x-ratelimit-remaining-requests": status === 200 ? "42" : "0" },
          }
        );
        const result = await runProviderExecutionPipeline({
          policy: { allowAccountRotation: false, allowModelFallback: false },
          target: {
            provider: "openai",
            requestedModel: "requested-model-before-fallback",
            sourceFormat: targetFormat,
            targetFormat,
            stream,
          },
          connection: {
            initialConnectionId: connectionId,
            getCurrentConnectionId: () => connectionId,
            getCredentials: () => ({}),
            replaceCredentials() {},
            onCredentialsRefreshed() {},
            assertManagedLeaseFence() {},
            getProviderCredentials: async () => {
              throw new Error("the test must not request credentials");
            },
          },
          wire: {
            body: { model: "gpt-test" },
            currentModel: "gpt-test",
            triedModels: new Set(["gpt-test"]),
            setBodyAndModel() {},
          },
          state: {
            updatePendingStage() {},
            recordRateLimitHeaders: updateFromHeaders,
            recordRateLimitBody() {},
            async writeTerminalStatus() {},
            persistConnectionPatch() {},
            setConnectionRateLimitedUntil() {},
            lockModel() {},
            async recordAntigravityQuotaState() {},
            markAccountSemaphoreBlocked() {},
            isolateProbeFailures: () => false,
          },
          sendProviderAttempt: async () => ({
            response,
            url: "https://api.openai.test/v1/responses",
            headers: {},
            transformedBody: {},
          }),
        });
        const observed = getOpenAIRateLimitObservations({ connectionId });
        assert.equal(observed.observations[0]?.requests?.remaining, status === 200 ? 42 : 0);
        assert.equal(
          observed.observations[0]?.model,
          "gpt-test",
          "attribute headers to the actual wire model"
        );
        if (status === 200) {
          assert.equal(result.kind, "response");
          assert.equal(response.bodyUsed, false);
          assert.equal(await response.text(), "payload-stays-readable");
        }
      });
    }
  }
}
