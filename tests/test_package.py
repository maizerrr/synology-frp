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
    with tarfile.open(spk_path, "r:*") as archive:
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
    with tarfile.open(spk_path, "r:*") as archive:
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
    with tarfile.open(spk_path, "r:*") as archive:
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
    assert arch == ["x86_64"], "use the generic x86_64 arch, like the stock packages"
    for arm in ("aarch64", "armv7", "armada38x"):
        assert arm not in arch


def test_privilege_drops_root(spk_path):
    with tarfile.open(spk_path, "r:*") as archive:
        data = json.loads(archive.extractfile("conf/privilege").read().decode("utf-8"))
    assert data["defaults"]["run-as"] == "package"




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
    with tarfile.open(spk_path, "r:*") as archive:
        for name in archive.getnames():
            if not name.startswith("scripts/"):
                continue
            data = archive.extractfile(name).read()
            path = tmp_path / os.path.basename(name)
            path.write_bytes(data)
            result = subprocess.run(["sh", "-n", str(path)], capture_output=True, text=True)
            assert result.returncode == 0, "%s: %s" % (name, result.stderr)


def test_nginx_template_proxies_this_package(spk_path):
    with tarfile.open(spk_path, "r:*") as archive:
        text = archive.extractfile("conf/nginx/nginx.conf.template").read().decode("utf-8")
    assert "/webman/3rdparty/synology-frp/api/" in text
    assert "127.0.0.1:9844" in text


def test_archive_starts_with_info(spk_path):
    """DSM reads INFO from the first entry; anything else is "invalid format"."""
    with tarfile.open(spk_path, "r:*") as archive:
        assert archive.getnames()[0] == "INFO"


def test_archive_carries_no_metadata_entries(spk_path):
    """macOS bsdtar writes pax/appledouble entries that DSM rejects."""
    with tarfile.open(spk_path, "r:*") as archive:
        for member in archive.getmembers():
            assert "PaxHeader" not in member.name, member.name
            assert not os.path.basename(member.name).startswith("._"), member.name
            assert not member.pax_headers, member.name


def test_payload_tarball_is_clean_too():
    path = os.path.join(ROOT, "build", "package.tgz")
    assert os.path.exists(path), "run ./build.sh first"
    with tarfile.open(path, "r:gz") as archive:
        for member in archive.getmembers():
            assert "PaxHeader" not in member.name, member.name
            assert not member.pax_headers, member.name


def test_backend_version_matches_info(info):
    """The version the UI reports must never drift from INFO."""
    path = os.path.join(ROOT, "src", "backend", os.listdir(os.path.join(ROOT, "src", "backend"))[0], "app.py")
    candidates = [p for p in __import__("glob").glob(os.path.join(ROOT, "src", "backend", "*", "app.py"))]
    assert candidates
    text = open(candidates[0], encoding="utf-8").read()
    match = re.search(r'VERSION = "([^"]+)"', text)
    assert match, "no VERSION constant"
    assert match.group(1) == info["version"]


def test_spk_is_an_uncompressed_tar(spk_path):
    """DSM 7 refuses a gzipped container: the file must start with "INFO"."""
    with open(spk_path, "rb") as handle:
        head = handle.read(4)
    assert head == b"INFO", "spk must be an uncompressed tar (got %r)" % head


def test_ui_config_declares_a_vue_window_app(payload, info):
    """Official pattern: one Vue class, used as its own appWindow."""
    ui = json.loads((payload / "ui" / "config").read_text(encoding="utf-8"))
    assert "app.js" in ui, "ui/config must name the JS bundle"
    classes = {}
    for entries in ui.values():
        classes.update(entries)

    app = classes[info["dsmappname"]]
    assert app["type"] == "app"
    assert app["allUsers"] is True
    assert app["appWindow"] == info["dsmappname"]


def test_window_is_a_vue_component_not_an_iframe(payload):
    """DSM 7.2+ desktop/taskbar is Vue; ExtJS windows never register with it."""
    bundle = (payload / "ui" / "app.js").read_text(encoding="utf-8")
    assert "Vue.extend" in bundle
    assert "v-app-instance" in bundle
    assert "v-app-window" in bundle
    assert "tag: 'iframe'" not in bundle
    assert "Ext.define" not in bundle, "the ExtJS window does not work on DSM 7.4"


def test_ui_config_declares_a_vue_window_app(payload, info):
    """Official pattern: one Vue class, used as its own appWindow."""
    ui = json.loads((payload / "ui" / "config").read_text(encoding="utf-8"))
    assert "app.js" in ui, "ui/config must name the JS bundle"
    classes = {}
    for entries in ui.values():
        classes.update(entries)

    app = classes[info["dsmappname"]]
    assert app["type"] == "app"
    assert app["allUsers"] is True
    assert app["appWindow"] == info["dsmappname"]


def test_window_is_a_vue_component_not_an_iframe(payload):
    """DSM 7.2+ desktop/taskbar is Vue; ExtJS windows never register with it."""
    bundle = (payload / "ui" / "app.js").read_text(encoding="utf-8")
    assert "Vue.extend" in bundle
    assert "v-app-instance" in bundle
    assert "v-app-window" in bundle
    assert "tag: 'iframe'" not in bundle
    assert "Ext.define" not in bundle, "the ExtJS window does not work on DSM 7.4"
