"""Offline tests for idle_stop.py: the Databricks SDK and the web framework are faked,
so no credentials, network or FastAPI install are needed.
Run: python idle_stop_test.py   (pytest also picks these up)"""

import asyncio
import os
import sys
import time
import types

import idle_stop

stops = []


class _FakeApps:
    def stop(self, name):  # noqa: ANN001, ANN201
        stops.append(name)


class _FakeWorkspaceClient:
    def __init__(self):  # noqa: ANN204
        self.apps = _FakeApps()


# `from databricks.sdk import WorkspaceClient` inside _stop_app resolves to these.
sys.modules["databricks"] = types.ModuleType("databricks")
sys.modules["databricks.sdk"] = types.SimpleNamespace(WorkspaceClient=_FakeWorkspaceClient)


def _monitor(**env):  # noqa: ANN003, ANN202
    for k in ("IDLE_TIMEOUT_MIN", "IDLE_DRY_RUN", "DATABRICKS_APP_NAME", "IDLE_APP_NAME"):
        os.environ.pop(k, None)
    os.environ.update({"DATABRICKS_APP_NAME": "my-app", **env})
    stops.clear()
    return idle_stop.IdleMonitor()


def _age(m, minutes):  # noqa: ANN001, ANN202 — pretend the last request was `minutes` ago
    m._last_activity = time.monotonic() - minutes * 60


def test_active_app_is_left_alone():
    m = _monitor(IDLE_TIMEOUT_MIN="30")
    _age(m, 29)
    m.check_once()
    assert stops == []


def test_idle_app_stops_itself_once():
    m = _monitor(IDLE_TIMEOUT_MIN="30")
    _age(m, 31)
    m.check_once()
    m.check_once()  # the stop resets the clock, so no second call right after
    assert stops == ["my-app"]


def test_dry_run_only_logs():
    m = _monitor(IDLE_TIMEOUT_MIN="30", IDLE_DRY_RUN="true")
    _age(m, 31)
    m.check_once()
    assert stops == []


def test_unknown_app_name_never_calls_the_api():
    m = _monitor(IDLE_TIMEOUT_MIN="30")
    m.app_name = ""
    _age(m, 31)
    m.check_once()
    assert stops == []


def test_only_signed_in_requests_count_as_activity():
    os.environ.pop("IDLE_DISABLED", None)
    os.environ["DATABRICKS_CLIENT_ID"] = "test"
    _monitor()

    class FakeApp:  # stands in for FastAPI: captures the middleware it is given
        def middleware(self, kind):  # noqa: ANN001, ANN201
            assert kind == "http"
            return lambda fn: setattr(self, "mw", fn) or fn

    class Req:
        def __init__(self, headers):  # noqa: ANN001, ANN204
            self.headers = headers

    async def call_next(_req):  # noqa: ANN001, ANN202
        return "ok"

    app = FakeApp()
    m = idle_stop.install_idle_stop(app)
    _age(m, 31)
    assert asyncio.run(app.mw(Req({}), call_next)) == "ok"  # health probe: no header
    assert m.idle_seconds > 30 * 60
    asyncio.run(app.mw(Req({"x-forwarded-email": "someone@example.com"}), call_next))
    assert m.idle_seconds < 5


def test_not_on_databricks_does_nothing():
    os.environ.pop("DATABRICKS_CLIENT_ID", None)
    assert idle_stop.install_idle_stop(object()) is None


if __name__ == "__main__":
    tests = [f for name, f in sorted(globals().items()) if name.startswith("test_")]
    for t in tests:
        t()
        print("ok  ", t.__name__)
    print(f"{len(tests)} passed")
