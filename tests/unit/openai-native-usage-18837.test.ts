import assert from "node:assert/strict";
import test from "node:test";

import { supportsProviderQuota } from "../../src/shared/utils/providerQuotaVisibility.ts";

// Native OpenAI must reach Provider Quotas even before an optional Admin key is
// configured. Otherwise ordinary-key users can never see passive observations.
test("native OpenAI is offered in Provider Quotas without an Admin credential", () => {
  assert.equal(
    supportsProviderQuota("openai", { provider: "openai", providerSpecificData: {} }),
    true
  );
});

test("native OpenAI quota support does not depend on a generic quota endpoint", () => {
  assert.equal(supportsProviderQuota("openai"), true);
});

test("Codex quota visibility remains available independently of native OpenAI", () => {
  assert.equal(supportsProviderQuota("codex"), true);
});

test("compatible providers still need a usable mapped quota endpoint", () => {
  const provider = "openai-compatible-chat-18837";
  assert.equal(supportsProviderQuota(provider), false);
  assert.equal(
    supportsProviderQuota(provider, {
      provider,
      providerSpecificData: {
        quotaEndpoint: {
          url: "https://quota.example.test/usage",
          quotas: { requests: { used: "$.used", total: "$.limit" } },
        },
      },
    }),
    true
  );
});
