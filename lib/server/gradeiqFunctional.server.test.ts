/**
 * Call 3 (postFunctional) sends SwapUp's server key when one is set, so GradeIQ
 * accepts a re-run pass over an earlier fail (SUP-66); with no key it sends none.
 *
 * Run: node --test --experimental-strip-types --no-warnings lib/server/*.test.ts
 */
import "./testing/register.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const seen: { path: string; key: string | undefined; body: unknown }[] = [];
const readBody = (req: IncomingMessage) => new Promise<string>((res) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => res(s)); });
const server = createServer(async (req, res) => {
  const body = await readBody(req);
  seen.push({ path: (req.url || "").split("?")[0], key: req.headers["x-gradeiq-server-key"] as string | undefined, body: body ? JSON.parse(body) : null });
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
process.env.GRADEIQ_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.GRADEIQ_ENABLED = "1";
const { postFunctional } = await import("./gradeiq.ts");
after(() => server.close());

test("postFunctional sends x-gradeiq-server-key when GRADEIQ_SERVER_KEY is set", async () => {
  process.env.GRADEIQ_SERVER_KEY = "giq_server_test_key_0000000000000000";
  seen.length = 0;
  await postFunctional("6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", { mic: "pass", speaker: "fail" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, "/api/sessions/6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b/functional");
  assert.equal(seen[0].key, "giq_server_test_key_0000000000000000");
  assert.deepEqual(seen[0].body, { functional: { mic: "pass", speaker: "fail" }, merge: true });
});

test("postFunctional sends no key header when none is configured", async () => {
  delete process.env.GRADEIQ_SERVER_KEY;
  seen.length = 0;
  await postFunctional("7a2b3c4d-5e6f-4a70-9b8c-0d1e2f3a4b5c", { mic: "pass" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].key, undefined);
});
