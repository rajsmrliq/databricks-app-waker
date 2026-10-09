#!/usr/bin/env bash
# One-time Databricks setup for the waker (worker.mjs).
#   1. Creates (or finds) a dedicated service principal, "app-waker" by default
#      (override with WAKER_SP_NAME). Dedicated on purpose: never reuse an app's own SP —
#      it can read the app's data, and this credential will live outside Databricks.
#   2. Grants it CAN_MANAGE on each app. CAN_USE is not enough: Databricks refuses
#      start below CAN_MANAGE (tested).
#   3. Grants it CAN_READ on each app's source folder. A start redeploys the app's last
#      source AS THE CALLER; without read the app comes up "no files found".
# Apps deployed with a Declarative Automation Bundle: read README.md first. The bundle
# owns the app's ACL and its root folder's ACL, so grants 2 and 3 made here get wiped by
# the next deploy and belong in the bundle / on the folder above the bundle root.
# Usage:     ./setup.sh <app-name>...
# Requires:  databricks CLI authenticated as a workspace admin (pick a profile with
#            DATABRICKS_CONFIG_PROFILE=<name>), jq.
set -euo pipefail
# Git Bash on Windows rewrites "/Workspace/..." args into C:/Program Files/Git/...; no-op elsewhere.
export MSYS_NO_PATHCONV=1

APPS=("${@:?usage: setup.sh <app-name>...}")
NAME="${WAKER_SP_NAME:-app-waker}"

SP_JSON=$(databricks service-principals list --filter "displayName eq '$NAME'" --output json | jq '.[0] // empty')
if [[ -z "$SP_JSON" ]]; then
  echo "Creating service principal '$NAME'…"
  SP_JSON=$(databricks service-principals create --display-name "$NAME" --active --output json)
fi
SP=$(jq -r '.applicationId' <<<"$SP_JSON")
echo "Service principal '$NAME': application id $SP"

for APP in "${APPS[@]}"; do
  echo "[$APP] CAN_MANAGE on the app…"
  # update-permissions ADDS to the ACL (set-permissions would replace it — don't).
  databricks apps update-permissions "$APP" --json "{
    \"access_control_list\": [{\"service_principal_name\": \"$SP\", \"permission_level\": \"CAN_MANAGE\"}]
  }" >/dev/null
  # default_source_code_path survives while the app is stopped; active_deployment does not.
  SRC=$(databricks apps get "$APP" --output json | jq -r '.default_source_code_path // .active_deployment.source_code_path // empty')
  if [[ -z "$SRC" ]]; then
    echo "[$APP] no source folder found (never deployed?) — grant '$NAME' CAN_READ on it yourself."
    continue
  fi
  OBJ=$(databricks workspace get-status "$SRC" --output json | jq -r '.object_id')
  echo "[$APP] CAN_READ on $SRC…"
  databricks workspace update-permissions directories "$OBJ" --json "{
    \"access_control_list\": [{\"service_principal_name\": \"$SP\", \"permission_level\": \"CAN_READ\"}]
  }" >/dev/null
done

cat <<EOF

Done. Next:
  1. Account console -> User management -> Service principals -> $NAME ->
     Credentials & secrets -> Generate secret. Scope: Other APIs -> apps (NOT all-apis;
     the workspace settings page only offers all-apis). Copy it; it is shown once.
  2. In wrangler.toml set DATABRICKS_HOST, DATABRICKS_CLIENT_ID = $SP and LAUNCH_APPS, then:
       npx wrangler login
       npx wrangler deploy
       npx wrangler secret put DATABRICKS_CLIENT_SECRET
EOF
