/*
 * Databricks App waker (Cloudflare Worker).
 *
 * A stopped Databricks App answers 503 ("App Not Available") at its own URL and
 * cannot start itself. Point people at this Worker instead:
 *
 *     https://app-waker.<subdomain>.workers.dev/<app-name>[/any/deep/link?query]
 *
 * If the app is serving, they are 302'd straight into it. If it is stopped, this
 * starts it through the Apps API and shows a small "starting" page that polls
 * /__status/<app-name> every POLL_SECONDS (a refresh checks at once) and redirects
 * once the app really serves.
 *
 * Why a Worker and not a launcher App: something must be awake to catch the hit,
 * and the smallest Databricks App bills ~0.5 DBU/h around the clock. Workers bill
 * per request (free plan: 100k/day).
 *
 * Settings: wrangler.toml [vars]; the secret via `npx wrangler secret put
 * DATABRICKS_CLIENT_SECRET`. Setup and the reasoning behind each step: README.md.
 *
 * The URL is unauthenticated on purpose (the app itself still demands Databricks
 * sign-in, so no data is exposed); the worst a stranger with the link can do is
 * wake an allow-listed app.
 *
 * Tests: node --test worker.test.mjs
 */

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

// Module scope survives between requests while the isolate stays warm.
let token = { value: "", expires: 0 };

async function accessToken(env) {
  // OAuth M2M (client credentials) token for the waker's service principal, cached.
  // Scope "apps" only: mint the secret with just that scope (account console), so a
  // leaked one cannot reach any other API.
  if (Date.now() < token.expires) return token.value;
  const r = await fetch(`${env.DATABRICKS_HOST}/oidc/v1/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.DATABRICKS_CLIENT_ID}:${env.DATABRICKS_CLIENT_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=apps",
  });
  if (!r.ok) throw new HttpError(r.status, await r.text());
  const b = await r.json();
  token = { value: b.access_token, expires: Date.now() + ((b.expires_in ?? 3600) - 60) * 1000 };
  return token.value;
}

async function api(env, method, path) {
  const r = await fetch(`${env.DATABRICKS_HOST}/api/2.0/apps/${path}`, {
    method,
    body: method === "POST" ? "{}" : undefined,
    headers: { Authorization: `Bearer ${await accessToken(env)}`, "Content-Type": "application/json" },
  });
  if (!r.ok) throw new HttpError(r.status, await r.text());
  return r.json();
}

// The control plane says RUNNING a few seconds before ingress serves; until then
// the app URL still answers 503. A live app answers a signed-out probe with a
// redirect to login, which is all we need to know.
async function serving(url) {
  try {
    return (await fetch(url, { redirect: "manual" })).status !== 503;
  } catch {
    return true; // probe unreachable: trust the API states rather than strand the visitor
  }
}

// Start the app if it is stopped; report what the waiting page needs.
async function wake(env, app) {
  const a = await api(env, "GET", app);
  const compute = a.compute_status?.state ?? "";
  const status = a.app_status?.state ?? "";
  if (compute === "STOPPED") {
    try {
      await api(env, "POST", `${app}/start`);
    } catch (e) {
      // Concurrent visitors: "already starting" / "deploy pending" come back as errors and
      // are fine. A refusal is not (e.g. the grant is only CAN_USE, which cannot start):
      // swallowing it would leave the visitor on the waiting page for nothing.
      if (!(e instanceof HttpError) || e.status === 401 || e.status === 403) throw e;
      console.log(`start ${app}: ${e.message} ${e.body.slice(0, 300)}`);
    }
  }
  return {
    ready: compute === "ACTIVE" && status === "RUNNING" && (await serving(a.url)),
    failed: compute === "ERROR" || (compute === "ACTIVE" && status === "CRASHED"),
    url: a.url ?? "",
  };
}

const respond = (status, body, type) =>
  new Response(body, { status, headers: { "Content-Type": type, "Cache-Control": "no-store" } });

export default {
  async fetch(request, env) {
    const { pathname, search } = new URL(request.url);
    const apps = new Set((env.LAUNCH_APPS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    const statusCall = pathname.startsWith("/__status/");
    const [app, ...restParts] = pathname.replace(/^\/__status/, "").replace(/^\/+/, "").split("/");
    const rest = restParts.length ? "/" + restParts.join("/") : "";
    // Allow-list: the path never reaches the API unless it is one of ours.
    if (!apps.has(app)) return respond(404, "Unknown app.", "text/plain; charset=utf-8");
    let s;
    try {
      s = await wake(env, app);
    } catch (e) {
      console.log(`waker error for ${app}: ${e.message}`);
      return respond(502, `Could not reach Databricks (${e.message}). See the Worker logs.`,
                     "text/plain; charset=utf-8");
    }
    if (statusCall) return respond(200, JSON.stringify(s), "application/json");
    if (s.ready) {
      // Host comes from the Apps API, never the request, so this is no open redirect.
      return new Response(null, { status: 302, headers: { Location: s.url + rest + search, "Cache-Control": "no-store" } });
    }
    const pollMs = Math.max(5, Number(env.POLL_SECONDS) || 300) * 1000; // floor: never hammer the API
    return respond(200, PAGE.replaceAll("__APP__", app).replace("__POLL_MS__", pollMs), "text/html; charset=utf-8");
  },
};

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Starting __APP__</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f6f7;color:#1d1d1f}
 main{max-width:28rem;padding:2rem 1rem;text-align:center}
 .spin{width:2.5rem;height:2.5rem;margin:0 auto 1.5rem;border:4px solid #ddd;border-top-color:#ff3621;border-radius:50%;animation:s 1s linear infinite}
 @keyframes s{to{transform:rotate(360deg)}}
 @media (prefers-reduced-motion:reduce){.spin{animation:none}}
 @media (prefers-color-scheme:dark){body{background:#141414;color:#eee}.spin{border-color:#333;border-top-color:#ff3621}}
 small{color:#888}
</style></head><body><main>
<div class="spin" aria-hidden="true"></div>
<h1>__APP__ is starting</h1>
<p id="msg" role="status" aria-live="polite">It was asleep to save cost. This usually takes a few minutes. We keep checking and take you in automatically &mdash; or refresh to check now.</p>
<small id="t"></small>
</main><script>
const POLL_MS = __POLL_MS__;  // a refresh checks immediately
const app = "__APP__", rest = location.pathname.slice(app.length + 1), t0 = Date.now();
const msg = document.getElementById("msg"), t = document.getElementById("t");
setInterval(() => { t.textContent = Math.round((Date.now() - t0) / 1000) + " s"; }, 1000);
async function poll() {
  const s = (Date.now() - t0) / 1000;
  try {
    const d = await (await fetch("/__status/" + app, {cache: "no-store"})).json();
    if (d.ready) { location.replace(d.url + rest + location.search); return; }
    if (d.failed) { msg.textContent = "The app failed to start. Ask an admin to check its logs."; return; }
  } catch (e) { /* transient: keep polling */ }
  // a cold start is compute (~2 min) + redeploy + package install: ~7 min measured for a FastAPI app with pandas/duckdb
  if (s > 1200) { msg.textContent = "This is taking far longer than usual. Refresh to keep waiting, or ask an admin."; return; }
  if (s > 600) msg.textContent = "Taking longer than usual, still starting. Refresh to check now.";
  setTimeout(poll, POLL_MS);
}
poll();
</script></body></html>
`;
