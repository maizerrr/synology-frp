"""On-disk configuration: one editable frpc file plus a tiny meta file."""

import json
import os
import tempfile

FILE_NAMES = {"toml": "frpc.toml", "ini": "frpc.ini"}
DEFAULT_FORMAT = "toml"

TOML_TEMPLATE = """# frpc 配置 —— 改完点「保存并重启」即可生效
# 第一步：把下面两行改成你自己的 frps 服务器地址和端口
serverAddr = "your-server.example.com"
serverPort = 7000

# 连不上服务器时继续重试，而不是直接退出（NAS 上建议保持 false）
loginFailExit = false

# xtcp（P2P）打洞用的 STUN。frp 默认的 stun.easyvoip.com 在国内经常超时，
# 表现是日志里反复 "wait response from stun server timeout"、打洞失败。
# stun.miwifi.com 实测可用（会返回两个公网地址）。不用 xtcp 可以删掉这行。
natHoleStunServer = "stun.miwifi.com:3478"

# 示例：把本机 5000 端口（DSM 网页）映射到服务器的 6000 端口
# 不需要就整段删掉
[[proxies]]
name = "dsm-web"
type = "tcp"
localIP = "127.0.0.1"
localPort = 5000
remotePort = 6000
"""

INI_TEMPLATE = """# frpc 配置（旧版 INI 格式）—— 改完点「保存并重启」即可生效
# 第一步：把下面两行改成你自己的 frps 服务器地址和端口
[common]
server_addr = your-server.example.com
server_port = 7000
login_fail_exit = false

# 示例：把本机 5000 端口（DSM 网页）映射到服务器的 6000 端口
[dsm-web]
type = tcp
local_ip = 127.0.0.1
local_port = 5000
remote_port = 6000
"""


class StoreError(Exception):
    def __init__(self, message, field=None):
        super().__init__(message)
        self.message = message
        self.field = field


class Store:
    def __init__(self, var_dir):
        self.var_dir = var_dir
        self.meta_path = os.path.join(var_dir, "config.json")

    # -- meta ----------------------------------------------------------
    def load_meta(self):
        try:
            with open(self.meta_path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
            if isinstance(data, dict) and data.get("format") in FILE_NAMES:
                return data
        except (OSError, ValueError):
            pass
        for fmt in ("toml", "ini"):
            if os.path.exists(self.path_for(fmt)):
                return {"format": fmt}
        return {"format": DEFAULT_FORMAT}

    def save_meta(self, meta):
        os.makedirs(self.var_dir, exist_ok=True)
        payload = {"format": meta.get("format", DEFAULT_FORMAT)}
        self._atomic_write(self.meta_path, json.dumps(payload, indent=2) + "\n", mode=0o600)
        return payload

    # -- files ---------------------------------------------------------
    def path_for(self, fmt):
        return os.path.join(self.var_dir, FILE_NAMES[fmt])

    def other_format(self, fmt):
        return "ini" if fmt == "toml" else "toml"

    def template(self, fmt):
        return INI_TEMPLATE if fmt == "ini" else TOML_TEMPLATE

    def current(self):
        """(format, content) — seeds the default file on first use."""
        meta = self.load_meta()
        fmt = meta["format"]
        path = self.path_for(fmt)
        if not os.path.exists(path):
            self.write(fmt, self.template(fmt))
        try:
            with open(path, "r", encoding="utf-8") as handle:
                return fmt, handle.read()
        except OSError as exc:
            raise StoreError("读不到配置文件：%s" % (exc.strerror or exc))

    def write(self, fmt, content):
        if fmt not in FILE_NAMES:
            raise StoreError("不支持的配置格式", "format")
        if not content or not content.strip():
            raise StoreError("配置内容不能为空", "content")
        os.makedirs(self.var_dir, exist_ok=True)
        path = self.path_for(fmt)
        self._atomic_write(path, content if content.endswith("\n") else content + "\n", mode=0o600)

        # Only one config file may exist, otherwise it is unclear what runs.
        stale = self.path_for(self.other_format(fmt))
        if os.path.exists(stale):
            try:
                os.unlink(stale)
            except OSError:
                pass

        self.save_meta({"format": fmt})
        return path

    # -- helpers -------------------------------------------------------
    @staticmethod
    def _atomic_write(path, text, mode=0o600):
        directory = os.path.dirname(path)
        handle_fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=directory)
        try:
            with os.fdopen(handle_fd, "w", encoding="utf-8") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(tmp, mode)
            os.replace(tmp, path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
