import json
import os
import re
import subprocess
import tarfile

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture(scope="module")
def spk_path():
    subprocess.run(["./build.sh"], cwd=ROOT, check=True, capture_output=True, text=True)
    dist = os.path.join(ROOT, "dist")
    candidates = [name for name in os.listdir(dist) if name.endswith(".spk")]
    assert candidates, "build.sh produced no .spk"
    return os.path.join(dist, sorted(candidates)[-1])


@pytest.fixture(scope="module")
def info(spk_path):
    with tarfile.open(spk_path, "r:gz") as archive:
        text = archive.extractfile("INFO").read().decode("utf-8")
    pairs = {}
    for line in text.splitlines():
        match = re.match(r'^([a-zA-Z0-9_]+)="(.*)"$', line.strip())
        if match:
            pairs[match.group(1)] = match.group(2)
    return pairs


@pytest.fixture(scope="module")
def payload(spk_path, tmp_path_factory):
    target = tmp_path_factory.mktemp("payload")
    with tarfile.open(spk_path, "r:gz") as archive:
        member = archive.extractfile("package.tgz")
        nested = target / "package.tgz"
        nested.write_bytes(member.read())
    with tarfile.open(str(nested), "r:gz") as archive:
        try:
            archive.extractall(str(target / "root"), filter="data")
        except TypeError:
            archive.extractall(str(target / "root"))
    return target / "root"


def test_spk_layout(spk_path):
    with tarfile.open(spk_path, "r:gz") as archive:
        names = set(archive.getnames())
    for required in ("INFO", "package.tgz", "PACKAGE_ICON.PNG",
                     "scripts/postinst", "scripts/start-stop-status",
                     "conf/privilege", "conf/nginx/nginx.conf.template"):
        assert required in names, "missing %s" % required


def test_info_targets_x86_only(info):
    assert info["package"] == "synology-frp"
    assert info["dsmuidir"] == "ui"
    assert info["os_min_ver"].startswith("7.")
    arch = info["arch"].split()
    assert "x86_64" in arch
    assert "v1000" in arch  # DS1621+
    for arm in ("aarch64", "armv7", "armada38x"):
        assert arm not in arch


def test_privilege_drops_root(spk_path):
    with tarfile.open(spk_path, "r:gz") as archive:
        data = json.loads(archive.extractfile("conf/privilege").read().decode("utf-8"))
    assert data["defaults"]["run-as"] == "package"


def test_ui_config_is_a_url_window(payload, info):
    ui = json.loads((payload / "ui" / "config").read_text(encoding="utf-8"))
    entry = ui[".url"][info["dsmappname"]]
    assert entry["type"] == "url"
    assert entry["url"] == "index.html"
    assert entry["allUsers"] is True


def test_payload_contains_backend_ui_and_engine(payload):
    assert (payload / "backend" / "run.py").is_file()
    assert (payload / "backend" / "frpui" / "app.py").is_file()
    assert (payload / "ui" / "index.html").is_file()
    assert (payload / "ui" / "assets" / "app.js").is_file()
    engine = payload / "engine" / "frpc"
    if not engine.exists():
        pytest.skip("frpc not built (run engine/build.sh)")
    header = engine.read_bytes()[:20]
    assert header[:4] == b"\x7fELF"
    assert header[18:20] == b"\x3e\x00", "engine is not x86_64"


def test_frontend_is_self_contained(payload):
    html = (payload / "ui" / "index.html").read_text(encoding="utf-8")
    for match in re.findall(r'(?:src|href)="([^"]+)"', html):
        assert not match.startswith("http"), "external asset: %s" % match


def test_scripts_are_valid_shell(spk_path, tmp_path):
    with tarfile.open(spk_path, "r:gz") as archive:
        for name in archive.getnames():
            if not name.startswith("scripts/"):
                continue
            data = archive.extractfile(name).read()
            path = tmp_path / os.path.basename(name)
            path.write_bytes(data)
            result = subprocess.run(["sh", "-n", str(path)], capture_output=True, text=True)
            assert result.returncode == 0, "%s: %s" % (name, result.stderr)


def test_nginx_template_proxies_this_package(spk_path):
    with tarfile.open(spk_path, "r:gz") as archive:
        text = archive.extractfile("conf/nginx/nginx.conf.template").read().decode("utf-8")
    assert "/webman/3rdparty/synology-frp/api/" in text
    assert "127.0.0.1:9844" in text
