import json
import os
import signal
import sys
import threading
import time
import urllib.error
import urllib.request

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND = os.path.join(ROOT, "src", "backend")
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

from frpui.app import create_server  # noqa: E402


class Client:
    def __init__(self, base, var_dir):
        self.base = base
        self.var_dir = var_dir

    def request(self, method, path, payload=None):
        headers = {"Accept": "application/json"}
        data = None
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                body = response.read().decode("utf-8")
                return response.status, json.loads(body) if body else {}
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8")
            try:
                return exc.code, json.loads(body)
            except ValueError:
                return exc.code, {"raw": body}

    def get(self, path):
        return self.request("GET", path)

    def put(self, path, payload):
        return self.request("PUT", path, payload)

    def post(self, path, payload=None):
        return self.request("POST", path, payload)

    def path(self, *parts):
        return os.path.join(self.var_dir, *parts)


FAKE_FRPC = """#!/bin/sh
case "$1" in
  --version) echo "0.72.0-fake"; exit 0 ;;
esac
CONFIG="$2"
if [ -f "$CONFIG" ] && grep -q BROKEN "$CONFIG" 2>/dev/null; then
  echo "parse config error: unknown field BROKEN" >&2
  exit 1
fi
echo "login to server success, get run id [abc123]"
while :; do sleep 0.5; done
"""


@pytest.fixture
def fake_binary(tmp_path):
    path = tmp_path / "frpc-fake"
    path.write_text(FAKE_FRPC, encoding="utf-8")
    path.chmod(0o755)
    return path


def _stop_leftovers(var_dir):
    pid_file = os.path.join(var_dir, "frpc.pid")
    try:
        with open(pid_file, "r", encoding="utf-8") as handle:
            pid = int(handle.read().strip())
    except (OSError, ValueError):
        return
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass


@pytest.fixture
def client(tmp_path, fake_binary, monkeypatch):
    monkeypatch.setenv("FRPUI_FRPC_BIN", str(fake_binary))
    var_dir = str(tmp_path / "var")
    server = create_server(var_dir, port=0)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    base = "http://127.0.0.1:%d" % server.server_address[1]
    time.sleep(0.05)
    try:
        yield Client(base, var_dir)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        _stop_leftovers(var_dir)
