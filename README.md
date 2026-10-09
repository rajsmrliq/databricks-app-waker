# databricks-app-waker

Wake a stopped [Databricks App](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/) when someone opens its link.

A stopped Databricks App shows an "App Not Available" page at its own URL and cannot start itself, so an app you stop to save money stays down until someone starts it by hand. This is a single-file Cloudflare Worker you put in front of the app:

```
https://app-waker.<subdomain>.workers.dev/<app-name>[/any/deep/link?query]
```

- **App running:** the visitor is redirected straight in (deep link and query kept).
- **App stopped:** the Worker starts it through the Apps API and shows a "<app> is starting" page that re-checks every `POLL_SECONDS` and redirects once the app really serves. A refresh checks at once.
- **App crashed or the start is refused:** the page says so instead of spinning.

The repo also has the other half, [`idle_stop.py`](idle_stop.py): drop it into your app and the app stops itself when nobody is using it (see [Stopping](#stopping)).

## Why a Worker

Something has to be awake to catch the visit. The smallest Databricks App (Medium, 0.5 DBU/h) costs about as much running all month as the app it would be waking, roughly $274/month at the $0.75/DBU AWS list price. A Worker bills per request, and the free plan (100k requests/day) covers this many times over, so the waker costs $0. The URL lives outside Databricks, which is why the setup below is careful about the credential.

## Setup

You need: the Databricks CLI signed in as a workspace admin, `jq`, Node.js 18+, and a Cloudflare account (free, no card).

1. **Databricks identity and grants** (once per workspace; re-run to add apps):

   ```bash
   ./setup.sh my-app other-app
   ```

   Creates a dedicated service principal `app-waker`, grants it `CAN_MANAGE` on each app and `CAN_READ` on each app's source folder, and prints its application id. If your apps are deployed with a bundle, read [Apps deployed with a bundle](#apps-deployed-with-a-bundle) first.

2. **Secret, scoped to the Apps API only.** In the **account console** (not workspace settings): User management → Service principals → `app-waker` → Credentials & secrets → Generate secret → Scope: **Other APIs → `apps`**. The workspace settings page only offers `all-apis`, which Databricks itself labels "a leaked credential would be unrestricted". Copy the secret; it is shown once. Pick a lifetime you will remember to rotate; when it expires, the waker answers `HTTP 401`.

3. **Cloudflare.** Edit `wrangler.toml` (`DATABRICKS_HOST`, `DATABRICKS_CLIENT_ID`, `LAUNCH_APPS`), then:

   ```bash
   npx wrangler login
   npx wrangler deploy
   npx wrangler secret put DATABRICKS_CLIENT_SECRET
   ```

   A new Cloudflare account must verify its email and have a workers.dev subdomain (Workers & Pages → Subdomain) before the first deploy succeeds. A freshly registered subdomain can take a few minutes to get its TLS certificate.

4. **Share** `https://app-waker.<subdomain>.workers.dev/<app-name>` instead of the app's own URL.

## How it decides "ready"

| Apps API state | What the waker does |
|---|---|
| compute `STOPPED` | calls `start` (an "already starting" error is fine; 401/403 is shown as an error) |
| compute `STARTING`, app `DEPLOYING`/`UNAVAILABLE` | waiting page |
| compute `ACTIVE`, app `RUNNING`, app URL not `503` | redirect |
| compute `ERROR`, or `ACTIVE` + app `CRASHED` | "failed to start" |

The extra check against the app URL is needed because Databricks reports `RUNNING` a few seconds before the URL stops answering `503`. Status comes from the API, not from pinging the app: the app URL sits behind Databricks sign-in, so a plain HTTP ping only ever sees a login redirect.

## Things we learned the hard way

Measured on one AWS workspace in October 2026:

- **`CAN_USE` cannot start an app.** We tested it: with `CAN_USE`, Databricks refused the start. The waker needs `CAN_MANAGE`.
- **A start redeploys the app's last source as the caller.** The waker's service principal therefore needs read access on the source folder. Without it the compute starts and the app fails with "no files found".
- **A cold start took about 7 minutes** for a FastAPI app with pandas and duckdb: ~2 min compute, ~3 min waiting for the redeploy, ~1.5 min downloading code and installing packages. Smaller dependency lists start faster.
- **Stopped apps are not billed**, and the waker's own calls cost nothing on the Databricks side.

## Apps deployed with a bundle

If a Declarative Automation Bundle deploys the app, the bundle owns two ACLs, and grants made by `setup.sh` on them are wiped by a later deploy:

- **The app's permissions.** Declare the waker there instead, e.g. in the app resource:

  ```yaml
  permissions:
    - service_principal_name: <waker application id>
      level: CAN_MANAGE
  ```

  Once the bundle manages that list, declare every other principal that relies on a hand grant too, such as the app's own service principal if the app stops itself.
- **The bundle root folder.** Every deploy re-applies the bundle's top-level `permissions` to its root folder, replacing the folder's direct ACL. Grant `CAN_READ` on the folder **above** the bundle root instead (`databricks workspace update-permissions directories <object-id> ...`): that grant is inherited and the bundle never touches it. `databricks bundle validate` will then warn that the folder has a permission not declared in the bundle; that warning is harmless.

## Stopping

Standard Databricks Apps never stop on their own. Pick one:

- **When idle (recommended): [`idle_stop.py`](idle_stop.py).** Copy it into your app; for FastAPI/Starlette it is two lines after `app = FastAPI(...)`:

  ```python
  from idle_stop import install_idle_stop
  install_idle_stop(app)
  ```

  The app stops itself after `IDLE_TIMEOUT_MIN` (default 30) minutes without signed-in user requests. Only requests carrying `X-Forwarded-Email` count, so platform health checks never keep it awake. Set `IDLE_DRY_RUN=true` on the first deploy to watch the log line before it stops anything; the module's docstring lists every setting and how to wire other frameworks. One grant, once per app: the app's **own** service principal needs `CAN_MANAGE` on the app (declare it in the bundle's `permissions` if a bundle manages the app):

  ```bash
  SP=$(databricks apps get my-app -o json | jq -r .service_principal_client_id)
  databricks apps update-permissions my-app --json "{\"access_control_list\": [{\"service_principal_name\": \"$SP\", \"permission_level\": \"CAN_MANAGE\"}]}"
  ```

- **On a schedule:** a job that runs `databricks apps stop <app-name>` in the evening. Blunter: it also stops an app someone is using.

## Security

- **The waker URL needs no sign-in.** The app still requires Databricks sign-in, so no data is exposed. Someone holding the link can only wake an allow-listed app, which costs the app's compute until your stop mechanism puts it back to sleep. Keep the link internal.
- **The secret is limited to the Apps API** (`apps` scope) and to what the service principal holds: `CAN_MANAGE` on the listed apps and read on their source. `CAN_MANAGE` also allows redeploying or deleting those apps, so treat the secret like a deploy credential.
- **Cloudflare never shows a stored secret again**, but anyone who can deploy to your Cloudflare account could change the code to leak it. Turn on 2FA.
- **Remove "Databricks SQL access"** from the service principal's entitlements; the waker does not use it.

## Files

| File | What |
|---|---|
| `worker.mjs` | the Worker |
| `worker.test.mjs` | offline tests (fake Databricks): `node --test worker.test.mjs` |
| `wrangler.toml` | Worker name and non-secret settings |
| `setup.sh` | one-time Databricks service principal and grants |
| `idle_stop.py` | the stop half: drop into your app so it stops itself when idle |
| `idle_stop_test.py` | offline tests (fake SDK and framework): `python idle_stop_test.py` |

## License

MIT, see [LICENSE](LICENSE).
