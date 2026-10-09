// Offline tests for worker.mjs: fetch is faked, so no credentials or network are needed.
// Run: node --test worker.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.mjs";

const HOST = "https://example.cloud.databricks.com";
const APP_URL = "https://my-app-1234567890.aws.databricksapps.com";
const env = { DATABRICKS_HOST: HOST, DATABRICKS_CLIENT_ID: "id", DATABRICKS_CLIENT_SECRET: "secret", LAUNCH_APPS: "my-app" };

// A fake Databricks: state the test can flip, and a log of every call made.
function fakeDatabricks(state) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push(`${method} ${url.replace(HOST, "")}`);
    if (url === `${HOST}/oidc/v1/token`) {
      // like Databricks: a secret minted with only the apps scope refuses any wider request
      if (!init.body.endsWith("scope=apps")) return new Response("invalid_scope", { status: 400 });
      return Response.json({ access_token: "t", expires_in: 3600 });
    }
    if (url === `${HOST}/api/2.0/apps/my-app/start`) {
      if (state.startForbidden) return new Response("PERMISSION_DENIED", { status: 403 });
      return new Response("already starting", { status: 400 });
    }
    if (url === `${HOST}/api/2.0/apps/my-app`) {
      if (state.apiDown) return new Response("Forbidden", { status: 403 });
      return Response.json({ compute_status: { state: state.compute }, app_status: { state: state.app }, url: APP_URL });
    }
    if (url === APP_URL) return new Response(null, { status: state.serving ? 302 : 503 });
    throw new Error(`unexpected fetch ${url}`);
  };
  return calls;
}

const get = (path, e = env) => worker.fetch(new Request(`https://waker.test${path}`), e);
const status = async () => (await get("/__status/my-app")).json();

test("only allow-listed apps reach the API", async () => {
  const calls = fakeDatabricks({ compute: "STOPPED", app: "UNAVAILABLE" });
  assert.equal((await get("/evil")).status, 404);
  assert.equal((await get("/__status/evil")).status, 404);
  assert.deepEqual(calls, []);
});

test("stopped app: start is sent (its error tolerated) and the waiting page shows", async () => {
  const calls = fakeDatabricks({ compute: "STOPPED", app: "UNAVAILABLE" });
  const r = await get("/my-app/reports/q3?d=1");
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /my-app is starting/);
  assert.match(html, /const POLL_MS = 300000;/); // default when POLL_SECONDS is unset
  assert.ok(calls.includes("POST /api/2.0/apps/my-app/start"));
});

test("POLL_SECONDS sets the poll interval, with a floor", async () => {
  fakeDatabricks({ compute: "STOPPED", app: "UNAVAILABLE" });
  assert.match(await (await get("/my-app", { ...env, POLL_SECONDS: "30" })).text(), /const POLL_MS = 30000;/);
  assert.match(await (await get("/my-app", { ...env, POLL_SECONDS: "1" })).text(), /const POLL_MS = 5000;/);
});

test("starting app: no second start, not ready", async () => {
  const calls = fakeDatabricks({ compute: "STARTING", app: "DEPLOYING" });
  assert.deepEqual(await status(), { ready: false, failed: false, url: APP_URL });
  assert.ok(!calls.some((c) => c.startsWith("POST /api/2.0/apps")));
});

test("RUNNING but ingress still 503 is not ready", async () => {
  fakeDatabricks({ compute: "ACTIVE", app: "RUNNING", serving: false });
  assert.equal((await status()).ready, false);
});

test("serving app: 302 into it, deep link and query kept", async () => {
  fakeDatabricks({ compute: "ACTIVE", app: "RUNNING", serving: true });
  const r = await get("/my-app/reports/q3?d=1");
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("Location"), `${APP_URL}/reports/q3?d=1`);
  assert.equal((await get("/my-app")).headers.get("Location"), APP_URL);
});

test("crashed app is reported as failed", async () => {
  fakeDatabricks({ compute: "ACTIVE", app: "CRASHED", serving: true });
  assert.equal((await status()).failed, true);
});

test("Databricks refusing the waker is a 502, not a crash", async () => {
  fakeDatabricks({ apiDown: true });
  assert.equal((await get("/my-app")).status, 502);
});

test("start refused (e.g. only CAN_USE) is a 502, not an endless waiting page", async () => {
  fakeDatabricks({ compute: "STOPPED", app: "UNAVAILABLE", startForbidden: true });
  const r = await get("/my-app");
  assert.equal(r.status, 502);
  assert.match(await r.text(), /HTTP 403/);
});
