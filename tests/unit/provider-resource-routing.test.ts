import test from "node:test";
import assert from "node:assert/strict";
import {
  parseProviderRoutingHeaders,
  selectProviderRoutingConnection,
  ProviderRoutingError,
} from "../../src/sse/services/providerResourceRouting.ts";

const headers = (values: Record<string, string>) => new Headers(values);
const select = (values: Record<string, string>) => {
  const result = parseProviderRoutingHeaders(headers(values));
  assert.ok(result);
  return result;
};
const connection = (id: string, priority: number, extra: Record<string, unknown> = {}) => ({
  id,
  provider: "openai",
  authType: "apikey",
  priority,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  isActive: true,
  apiKey: `fixture-${id}`,
  providerSpecificData: { extraApiKeys: [{ id: "extra", key: "fixture-extra" }] },
  ...extra,
});
const status = (expected: number) => (error: unknown) =>
  error instanceof ProviderRoutingError && error.status === expected;

test("no new selector preserves legacy and connection-only requests", () => {
  assert.equal(parseProviderRoutingHeaders(headers({})), null);
  assert.equal(parseProviderRoutingHeaders(headers({ "x-omniroute-connection": "old-pin" })), null);
});

test("provider defaults to zero; google is a canonical Gemini alias", () => {
  assert.deepEqual(select({ "x-omniroute-provider": " OPENAI " }), {
    provider: "openai",
    keyIndex: 0,
    explicitIndex: false,
    connectionId: null,
  });
  assert.equal(select({ "x-omniroute-provider": "google" }).provider, "gemini");
  assert.equal(
    select({ "x-omniroute-provider": "gemini", "x-omniroute-key-index": "2" }).keyIndex,
    2
  );
});

test("index requires provider and rejects invalid, fractional, signed and unsafe integers", () => {
  assert.throws(() => select({ "x-omniroute-key-index": "0" }), status(400));
  for (const value of ["", "-1", "+1", "1.2", "1e2", "NaN", "9007199254740992", "0,1"]) {
    assert.throws(
      () => select({ "x-omniroute-provider": "openai", "x-omniroute-key-index": value }),
      status(400)
    );
  }
  for (const provider of ["", "codex", "gemini-cli", "openai-compatible-x"]) {
    assert.throws(() => select({ "x-omniroute-provider": provider }), status(400));
  }
});

test("index order is stable priority, creation, id and never mutable update time", () => {
  const a = connection("a", 1, { updatedAt: "2026-01-01" });
  const b = connection("b", 1, { updatedAt: "2027-01-01" });
  const c = connection("c", 2);
  const selection = select({ "x-omniroute-provider": "openai" });
  assert.equal(selectProviderRoutingConnection(selection, [c, b, a]).connectionId, "a");
  const second = select({ "x-omniroute-provider": "openai", "x-omniroute-key-index": "1" });
  assert.equal(selectProviderRoutingConnection(second, [c, b, a]).connectionId, "b");
  assert.throws(
    () => selectProviderRoutingConnection({ ...second, keyIndex: 9 }, [a]),
    status(400)
  );
});

test("inactive, missing primary and terminal accounts fail without shifting the index", () => {
  const selection = select({ "x-omniroute-provider": "openai" });
  for (const patch of [
    { isActive: false },
    { apiKey: "" },
    { testStatus: "banned" },
    { testStatus: "expired" },
    { testStatus: "credits_exhausted" },
  ]) {
    assert.throws(
      () =>
        selectProviderRoutingConnection(selection, [connection("a", 1, patch), connection("b", 2)]),
      status(503)
    );
  }
  assert.throws(
    () =>
      selectProviderRoutingConnection(selection, [
        connection("a", 1, { rateLimitedUntil: "2999-01-01T00:00:00Z" }),
        connection("b", 2),
      ]),
    status(429)
  );
});

test("permission is checked after index resolution and cannot renumber the pool", () => {
  const pool = [connection("a", 1), connection("b", 2)];
  const selection = select({ "x-omniroute-provider": "openai" });
  assert.throws(() => selectProviderRoutingConnection(selection, pool, ["b"]), status(403));
  assert.throws(() => selectProviderRoutingConnection(selection, pool, []), status(403));
  assert.equal(
    selectProviderRoutingConnection({ ...selection, keyIndex: 1 }, pool, ["b"]).connectionId,
    "b"
  );
});

test("stable connection id survives reorder; an explicitly conflicting index is rejected", () => {
  const pool = [connection("a", 1), connection("b", 2)];
  const stable = select({ "x-omniroute-provider": "openai", "x-omniroute-connection": "b" });
  assert.equal(selectProviderRoutingConnection(stable, pool).connectionId, "b");
  assert.equal(selectProviderRoutingConnection(stable, pool).keyIndex, 1);
  assert.equal(
    selectProviderRoutingConnection(stable, [connection("a", 5), connection("b", 1)]).keyIndex,
    0
  );
  const conflicting = select({
    "x-omniroute-provider": "openai",
    "x-omniroute-connection": "b",
    "x-omniroute-key-index": "0",
  });
  assert.throws(() => selectProviderRoutingConnection(conflicting, pool), status(400));
  assert.throws(
    () => selectProviderRoutingConnection({ ...stable, connectionId: "absent" }, pool),
    status(400)
  );
});

test("only native API-key rows count and returned credentials cannot rotate extra keys", () => {
  const a = connection("a", 1);
  const pool = [
    connection("oauth", 0, { authType: "oauth" }),
    connection("google", 0, { provider: "gemini" }),
    a,
  ];
  const result = selectProviderRoutingConnection(
    select({ "x-omniroute-provider": "openai" }),
    pool
  );
  assert.equal(result.connectionId, "a");
  assert.equal(result.apiKey, "fixture-a");
  assert.deepEqual(result.providerSpecificData.extraApiKeys, []);
  assert.equal(a.providerSpecificData.extraApiKeys.length, 1);
});
