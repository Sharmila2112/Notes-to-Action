import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeHistoryCursor, encodeHistoryCursor } from "./run-history-cursor";

const id = "12345678-1234-4234-8234-123456789abc";

test("history cursors preserve PostgreSQL microseconds without storing note text or ownership", () => {
  const at = "2026-10-23T12:00:00.000017Z";
  const encoded = encodeHistoryCursor(at, id);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.ok(encoded.length < 256);
  assert.deepEqual(decodeHistoryCursor(encoded), { v: 1, at, id });
});

test("filter-bound cursors preserve the filter fingerprint without exposing filter text", () => {
  const at = "2026-10-23T12:00:00.000017Z";
  const filterHash = "a".repeat(64);
  const encoded = encodeHistoryCursor(at, id, filterHash);
  assert.ok(!Buffer.from(encoded, "base64url").toString().includes("search text"));
  assert.deepEqual(decodeHistoryCursor(encoded), { v: 2, at, id, filterHash });
});

test("history cursors reject malformed, oversized, unsupported, and impossible values", () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const value of [
    "", "not-json", "a".repeat(257), "%%%==", encode(null), encode([]),
    encode({ v: 2, at: "2026-10-23T12:00:00.000017Z", id }),
    encode({ v: 1, at: "2026-10-23T12:00:00.000017Z", id: "not-a-uuid" }),
    encode({ v: 1, at: "2026-02-30T12:00:00.000017Z", id }),
    encode({ v: 1, at: "2026-10-23T25:00:00.000017Z", id }),
    encode({ v: 1, at: "2026-10-23T12:00:00.017Z", id }),
    encode({ v: 1, at: "2026-10-23T12:00:00.000017+02:00", id }),
    encode({ v: 2, at: "2026-10-23T12:00:00.000017Z", id, filterHash: "bad" }),
  ]) assert.throws(() => decodeHistoryCursor(value), /Invalid history cursor/);
});
