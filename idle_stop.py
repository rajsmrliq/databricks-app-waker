"""
Idle self-stop for a Databricks App: the stop half that pairs with the waker.

Standard Databricks Apps never stop on their own; a running app bills compute
until someone stops it. Drop this file into your app and it stops the app ITSELF
after a period without user requests, by calling the Apps API
(`apps.stop(<app name>)`) with the app's own service-principal credentials.
The waker (worker.mjs) starts it again on the next visit.

How it works
------------
1. A middleware stamps "last activity" on every *real user* request: one that
   carries the `X-Forwarded-Email` header, which the Databricks Apps proxy adds to
   requests from signed-in users. Platform health probes don't carry it, so they
   can never keep the app awake.
2. A daemon thread checks every IDLE_CHECK_SEC seconds; after IDLE_TIMEOUT_MIN
   minutes without user activity it stops the app. Compute goes to zero; the
   deployment and its data are untouched. The timer also starts at boot, so an
   app that is started and never opened stops too.

Wiring (FastAPI / Starlette), 2 lines after `app = FastAPI(...)`:

    from idle_stop import install_idle_stop
    install_idle_stop(app)

Other frameworks: create `IdleMonitor()`, run `monitor.run_forever` in a daemon
thread, and call `monitor.touch()` for each request that has X-Forwarded-Email.

Settings (environment variables, all optional — set them in app.yaml `env`):

    IDLE_TIMEOUT_MIN   minutes without user requests before the stop  (default 30)
    IDLE_CHECK_SEC     seconds between checks                        (default 60)
    IDLE_DRY_RUN       "true" = log the would-be stop instead         (default false)
    IDLE_DISABLED      "true" = feature off                           (default false)
    IDLE_APP_NAME      app name, if DATABRICKS_APP_NAME is absent

Prerequisite: the app's OWN service principal needs CAN_MANAGE on the app (see
README.md). Without it the stop call is refused; this logs the error and retries.

Safe by construction: does nothing when not running on Databricks Apps (no
DATABRICKS_CLIENT_ID), so local dev and tests are unaffected; every error is
caught and logged, so the app never crashes because of this module.

Requires databricks-sdk (preinstalled in the Databricks Apps runtime; pin a
current version in requirements.txt — very old ones called retired Apps endpoints).

Tests: python idle_stop_test.py
"""

from __future__ import annotations

import logging
import os
import threading
import time

logger = logging.getLogger("idle_stop")
# Nothing configures Python logging in a bare app process, so at the default root
# level the INFO lines never reach the app logs. Give this module its own handler.
if not logger.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("[idle-stop] %(levelname)s %(message)s"))
    logger.addHandler(_h)
    logger.setLevel(logging.INFO)
    logger.propagate = False


def _env_bool(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "") or default)
    except ValueError:
        logger.warning("Bad value for %s; using default %s", name, default)
        return default


class IdleMonitor:
    """Tracks the last user request and stops the app when idle too long."""

    def __init__(self) -> None:
        self.timeout_sec = _env_float("IDLE_TIMEOUT_MIN", 30.0) * 60.0
        self.check_interval = _env_float("IDLE_CHECK_SEC", 60.0)
        self.dry_run = _env_bool("IDLE_DRY_RUN", False)
        self.app_name = os.getenv("DATABRICKS_APP_NAME") or os.getenv("IDLE_APP_NAME") or ""
        self._last_activity = time.monotonic()  # timer starts at boot
        self._lock = threading.Lock()

    def touch(self) -> None:
        with self._lock:
            self._last_activity = time.monotonic()

    @property
    def idle_seconds(self) -> float:
        with self._lock:
            return time.monotonic() - self._last_activity

    def check_once(self) -> None:
        idle = self.idle_seconds
        if idle >= self.timeout_sec:
            self._stop_app(idle)
            # After a real stop the container is torn down shortly; after a dry run
            # or a failed stop, reset so the API isn't hit every check.
            self.touch()

    def run_forever(self) -> None:
        logger.info("Armed: app=%r timeout=%.0f min, check every %.0fs, dry_run=%s",
                    self.app_name, self.timeout_sec / 60, self.check_interval, self.dry_run)
        while True:
            time.sleep(self.check_interval)
            try:
                self.check_once()
            except Exception as e:  # noqa: BLE001 — never let this thread die
                if "PERMISSION_DENIED" in str(e) or "403" in str(e):
                    logger.error("Stop REFUSED (permission). The app's own service principal "
                                 "needs CAN_MANAGE on app %r (see README.md).", self.app_name)
                else:
                    logger.exception("Idle check failed; will retry")

    def _stop_app(self, idle: float) -> None:
        if not self.app_name:
            logger.error("Idle for %.0f min but the app name is unknown "
                         "(set IDLE_APP_NAME) — cannot stop.", idle / 60)
            return
        if self.dry_run:
            logger.warning("[DRY RUN] Would stop app %r now (idle %.0f min).", self.app_name, idle / 60)
            return
        logger.warning("App %r idle for %.0f min — stopping itself to save compute.",
                       self.app_name, idle / 60)
        from databricks.sdk import WorkspaceClient  # here, so local dev without the SDK works

        # Inside a Databricks App, DATABRICKS_HOST / CLIENT_ID / CLIENT_SECRET are
        # injected, so WorkspaceClient() needs no arguments.
        WorkspaceClient().apps.stop(name=self.app_name)


def install_idle_stop(app) -> IdleMonitor | None:  # noqa: ANN001 — FastAPI or Starlette app
    """Attach idle self-stop to a FastAPI/Starlette app. Returns the monitor, or None
    when disabled or not running on Databricks Apps."""
    if _env_bool("IDLE_DISABLED", False):
        logger.info("Disabled via IDLE_DISABLED.")
        return None
    if not os.getenv("DATABRICKS_CLIENT_ID"):
        logger.info("Not running on Databricks Apps — inactive.")
        return None

    monitor = IdleMonitor()

    @app.middleware("http")
    async def _idle_activity(request, call_next):  # noqa: ANN001, ANN202
        if request.headers.get("x-forwarded-email"):  # signed-in user, not a health probe
            monitor.touch()
        return await call_next(request)

    threading.Thread(target=monitor.run_forever, name="idle-stop", daemon=True).start()
    return monitor
