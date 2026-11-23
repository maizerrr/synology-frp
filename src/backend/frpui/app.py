"""Tiny HTTP service behind the DSM window (stdlib only, loopback only)."""

import json
import os
import re
import signal
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

from .store import FILE_NAMES, Store, StoreError
from .supervisor import Supervisor

VERSION = "1.0.1"
DEFAULT_PACKAGE = "synology-frp"
MAX_BODY = 4 * 1024 * 1024
DEFAULT_LINES = 80


class ApiError(Exception):
    def __init__(self, status, code, message, field=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.field = field

    def payload(self):
        body = {"code": self.code, "message": self.message}
        if self.field:
            body["field"] = self.field
        return body


class Request:
    def __init__(self, method, path, query, body, headers):
        self.method = method
        self.path = path
        self.query = query
        self.body = body
        self.headers = headers
        self.params = {}

    def json(self):
        if not self.body:
            return {}
        try:
            data = json.loads(self.body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "BAD_JSON", "请求内容不是合法的 JSON")
        if not isinstance(data, dict):
            raise ApiError(400, "BAD_JSON", "请求内容必须是对象")
        return data


class Context:
    def __init__(self, var_dir, package_id=DEFAULT_PACKAGE, static_dir=None):
        self.var_dir = var_dir
        self.package_id = package_id
        self.static_dir = os.path.abspath(static_dir) if static_dir else None
        self.store = Store(var_dir)
        self.supervisor = Supervisor(var_dir)

    def state(self):
        fmt, content = self.store.current()
        return {
            "format": fmt,
            "fileName": FILE_NAMES[fmt],
            "content": content,
            "formats": list(FILE_NAMES.keys()),
            "status": self.supervisor.status(),
        }


class Router:
    def __init__(self):
        self._routes = []

    def add(self, method, pattern, handler):
        self._routes.append((method.upper(), re.compile("^" + pattern + "$"), handler))

    def dispatch(self, ctx, request):
        for method, regex, handler in self._routes:
            if method != request.method:
                continue
            match = regex.match(request.path)
            if match:
                request.params = match.groupdict()
                return handler(ctx, request)
        raise ApiError(404, "NOT_FOUND", "没有这个接口")


# --------------------------------------------------------------------------
# handlers
# --------------------------------------------------------------------------

def handle_health(ctx, request):
    return 200, {"status": "ok", "version": VERSION, "package": ctx.package_id}


def handle_state(ctx, request):
    return 200, ctx.state()


def handle_save(ctx, request):
    payload = request.json()
    fmt = payload.get("format") or ctx.store.load_meta()["format"]
    content = payload.get("content")
    try:
        path = ctx.store.write(fmt, content)
    except StoreError as exc:
        raise ApiError(422, "INVALID_CONFIG", exc.message, exc.field)

    result = ctx.supervisor.restart(path)
    return 200, {
        "saved": True,
        "started": bool(result.get("started")),
        "error": result.get("error", ""),
        "state": ctx.state(),
    }


def handle_start(ctx, request):
    fmt, _ = ctx.store.current()
    result = ctx.supervisor.start(ctx.store.path_for(fmt))
    return 200, {"started": bool(result.get("started")), "error": result.get("error", ""),
                 "state": ctx.state()}


def handle_stop(ctx, request):
    ctx.supervisor.stop()
    return 200, {"stopped": True, "state": ctx.state()}


def handle_restart(ctx, request):
    fmt, _ = ctx.store.current()
    result = ctx.supervisor.restart(ctx.store.path_for(fmt))
    return 200, {"started": bool(result.get("started")), "error": result.get("error", ""),
                 "state": ctx.state()}


def handle_template(ctx, request):
    fmt = request.query.get("format") or ctx.store.load_meta()["format"]
    if fmt not in FILE_NAMES:
        raise ApiError(422, "INVALID_FORMAT", "不支持的配置格式", "format")
    return 200, {"format": fmt, "content": ctx.store.template(fmt)}


def handle_logs(ctx, request):
    try:
        count = max(1, min(500, int(request.query.get("lines") or DEFAULT_LINES)))
    except ValueError:
        count = DEFAULT_LINES
    return 200, {
        "path": ctx.supervisor.log_path,
        "lines": ctx.supervisor.last_lines(count),
    }


def build_router():
    router = Router()
    router.add("GET", r"/api/health", handle_health)
    router.add("GET", r"/api/state", handle_state)
    router.add("PUT", r"/api/file", handle_save)
    router.add("POST", r"/api/start", handle_start)
    router.add("POST", r"/api/stop", handle_stop)
    router.add("POST", r"/api/restart", handle_restart)
    router.add("GET", r"/api/template", handle_template)
    router.add("GET", r"/api/logs", handle_logs)
    return router


# --------------------------------------------------------------------------
# http plumbing
# --------------------------------------------------------------------------

_STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
}


def _make_handler(ctx, router):
    class Handler(BaseHTTPRequestHandler):
        server_version = "SynologyFrp/" + VERSION
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            return

        def do_GET(self):
            self._handle("GET")

        def do_PUT(self):
            self._handle("PUT")

        def do_POST(self):
            self._handle("POST")

        def do_DELETE(self):
            self._handle("DELETE")

        def _handle(self, method):
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            query = {}
            if parsed.query:
                for pair in parsed.query.split("&"):
                    if "=" in pair:
                        key, value = pair.split("=", 1)
                        query[unquote(key)] = unquote(value)
            try:
                body = self._read_body()
                if path.startswith("/api/"):
                    request = Request(method, path, query, body, self.headers)
                    status, payload = router.dispatch(ctx, request)
                    self._send_json(status, payload)
                else:
                    self._serve_static(path, method)
            except ApiError as exc:
                self._send_json(exc.status, exc.payload())
            except Exception as exc:  # pragma: no cover - defensive
                self._send_json(500, {"code": "INTERNAL", "message": "服务内部错误",
                                      "detail": str(exc)})

        def _read_body(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return b""
            if length > MAX_BODY:
                raise ApiError(413, "TOO_LARGE", "请求内容过大")
            return self.rfile.read(length)

        def _send_json(self, status, payload):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _serve_static(self, path, method):
            if method != "GET" or not ctx.static_dir:
                raise ApiError(404, "NOT_FOUND", "没有这个资源")
            relative = path.lstrip("/") or "index.html"
            candidate = os.path.abspath(os.path.normpath(os.path.join(ctx.static_dir, relative)))
            try:
                inside = os.path.commonpath([candidate, ctx.static_dir]) == ctx.static_dir
            except ValueError:
                inside = False
            if not inside:
                raise ApiError(403, "FORBIDDEN", "越界访问")
            if os.path.isdir(candidate):
                candidate = os.path.join(candidate, "index.html")
            if not os.path.isfile(candidate):
                raise ApiError(404, "NOT_FOUND", "没有这个资源")
            with open(candidate, "rb") as handle:
                data = handle.read()
            ext = os.path.splitext(candidate)[1].lower()
            self.send_response(200)
            self.send_header("Content-Type", _STATIC_TYPES.get(ext, "application/octet-stream"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    return Handler


def create_server(var_dir, host="127.0.0.1", port=9844, package_id=DEFAULT_PACKAGE, static_dir=None):
    os.makedirs(var_dir, exist_ok=True)
    ctx = Context(var_dir=var_dir, package_id=package_id, static_dir=static_dir)
    router = build_router()
    server = ThreadingHTTPServer((host, port), _make_handler(ctx, router))
    server.daemon_threads = True
    server.ctx = ctx
    return server


def main(argv=None):
    import argparse

    parser = argparse.ArgumentParser(description="Synology FRP client")
    parser.add_argument("--var-dir", default=os.environ.get("SYNOPKG_PKGVAR") or os.path.join(os.getcwd(), "run", "var"))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("SYNOFRP_PORT") or 9844))
    parser.add_argument("--package", default=os.environ.get("SYNOPKG_PKGNAME") or DEFAULT_PACKAGE)
    parser.add_argument("--static-dir", default=None)
    args = parser.parse_args(argv)

    server = create_server(
        var_dir=args.var_dir, host=args.host, port=args.port,
        package_id=args.package, static_dir=args.static_dir,
    )
    ctx = server.ctx

    # Bring frpc up with the saved configuration (also covers NAS reboots).
    try:
        fmt, _ = ctx.store.current()
        ctx.supervisor.start(ctx.store.path_for(fmt))
    except StoreError:
        pass

    import sys
    sys.stderr.write("synology-frp ui listening on %s:%s (var=%s)\n"
                     % (args.host, server.server_address[1], args.var_dir))

    def _stop(signum, frame):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        try:
            ctx.supervisor.stop()
        except Exception:
            pass
        server.server_close()


if __name__ == "__main__":
    main()
