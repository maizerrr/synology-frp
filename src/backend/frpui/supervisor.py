"""frpc process supervision.

The package owns the frpc process: start/stop/restart, a pid file, a capped log,
and "why did it die" reporting so the UI can show the real error instead of
claiming success.
"""

import os
import re
import subprocess
import time

ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")

LOG_LIMIT_BYTES = 2 * 1024 * 1024
START_GRACE_SECONDS = 0.9


def default_binary():
    explicit = os.environ.get("FRPUI_FRPC_BIN")
    if explicit:
        return explicit
    dest = os.environ.get("SYNOPKG_PKGDEST")
    if dest:
        return os.path.join(dest, "engine", "frpc")
    return ""


class Supervisor:
    def __init__(self, var_dir, binary=None):
        self.var_dir = var_dir
        self.binary = binary or default_binary()
        self.log_dir = os.path.join(var_dir, "logs")
        self.log_path = os.path.join(self.log_dir, "frpc.log")
        self.pid_path = os.path.join(var_dir, "frpc.pid")
        self._version = None

    # -- process state -------------------------------------------------
    def pid(self):
        try:
            with open(self.pid_path, "r", encoding="utf-8") as handle:
                return int(handle.read().strip())
        except (OSError, ValueError):
            return 0

    @staticmethod
    def _alive(pid):
        if not pid:
            return False
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    def running(self):
        return self._alive(self.pid())

    def status(self):
        pid = self.pid()
        alive = self._alive(pid)
        uptime = 0
        if alive:
            try:
                uptime = int(time.time() - os.path.getmtime(self.pid_path))
            except OSError:
                uptime = 0
        return {
            "running": alive,
            "pid": pid if alive else 0,
            "uptime": max(uptime, 0),
            "version": self.version(),
            "binaryPresent": bool(self.binary and os.path.exists(self.binary)),
            "connected": self.connection_state() if alive else None,
        }

    def connection_state(self):
        """True = logged in to the server, False = last attempt failed, None = unknown.

        frpc with loginFailExit=false keeps retrying, so "process alive" alone
        does not mean the tunnel is up.
        """
        for line in reversed(self.last_lines(200)):
            if "login to server success" in line:
                return True
            if "login to the server failed" in line or "connect to server error" in line:
                return False
        return None

    def version(self):
        if self._version is not None:
            return self._version
        self._version = ""
        if not self.binary or not os.path.exists(self.binary):
            return self._version
        try:
            result = subprocess.run([self.binary, "--version"], capture_output=True,
                                    text=True, timeout=10)
            text = (result.stdout or result.stderr or "").strip()
            if text:
                self._version = text.splitlines()[0].replace("frpc version", "").strip()
        except (OSError, subprocess.SubprocessError):
            pass
        return self._version

    # -- control -------------------------------------------------------
    def start(self, config_path):
        if self.running():
            return {"started": True, "pid": self.pid(), "error": ""}
        if not self.binary or not os.path.exists(self.binary):
            return {"started": False, "error": "套件里缺少 frpc 可执行文件，请重新安装套件"}
        if not os.path.exists(config_path):
            return {"started": False, "error": "找不到配置文件，请先保存一次"}

        os.makedirs(self.log_dir, exist_ok=True)
        self._rotate_log()
        stream = open(self.log_path, "ab")
        try:
            stream.write(("\n=== %s start %s ===\n" % (
                time.strftime("%Y-%m-%d %H:%M:%S"), os.path.basename(config_path))).encode("utf-8"))
            stream.flush()
            process = subprocess.Popen(
                [self.binary, "-c", config_path],
                stdout=stream, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                cwd=self.var_dir, start_new_session=True,
            )
        except OSError as exc:
            return {"started": False, "error": "启动 frpc 失败：%s" % (exc.strerror or exc)}
        finally:
            stream.close()

        with open(self.pid_path, "w", encoding="utf-8") as handle:
            handle.write(str(process.pid))

        time.sleep(START_GRACE_SECONDS)
        code = process.poll()
        if code is not None:
            try:
                os.unlink(self.pid_path)
            except OSError:
                pass
            return {
                "started": False,
                "exitCode": code,
                "error": io_error_text(self.last_run_lines(8), code),
            }
        return {"started": True, "pid": process.pid, "error": ""}

    def stop(self):
        pid = self.pid()
        if pid and self._alive(pid):
            try:
                os.kill(pid, 15)
            except OSError:
                pass
            for _ in range(20):
                if not self._alive(pid):
                    break
                time.sleep(0.1)
            if self._alive(pid):
                try:
                    os.kill(pid, 9)
                except OSError:
                    pass
        try:
            os.unlink(self.pid_path)
        except OSError:
            pass
        return {"running": False}

    def restart(self, config_path):
        self.stop()
        return self.start(config_path)

    # -- log -----------------------------------------------------------
    def _rotate_log(self):
        try:
            if os.path.getsize(self.log_path) > LOG_LIMIT_BYTES:
                os.replace(self.log_path, self.log_path + ".1")
        except OSError:
            pass

    def last_lines(self, count=80):
        try:
            with open(self.log_path, "rb") as handle:
                handle.seek(0, os.SEEK_END)
                size = handle.tell()
                chunk = min(size, 128 * 1024)
                handle.seek(size - chunk)
                data = handle.read()
        except OSError:
            return []
        text = ANSI_RE.sub("", data.decode("utf-8", errors="replace"))
        lines = text.splitlines()
        return lines[-count:] if count else lines

    def last_run_lines(self, count=8):
        """Only the output of the current run, not the previous one's noise."""
        lines = self.last_lines(400)
        marker = None
        for index in range(len(lines) - 1, -1, -1):
            if lines[index].startswith("=== "):
                marker = index
                break
        if marker is None:
            return lines[-count:]
        return lines[marker + 1:][-count:]


def io_error_text(lines, code):
    tail = [line for line in lines if line.strip()][-6:]
    detail = "\n".join(tail)
    head = "frpc 启动失败（退出码 %s）" % code
    return head + ("\n" + detail if detail else "\n（没有更多输出，可展开日志查看）")
