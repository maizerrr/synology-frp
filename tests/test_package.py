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
                     "conf/privilege", "conf/resource"):
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


def test_web_config_declares_the_api_location(spk_path, payload):
    """DSM 7.2+ only activates nginx snippets registered through conf/resource."""
    with tarfile.open(spk_path, "r:*") as archive:
        resource = json.loads(archive.extractfile("conf/resource").read().decode("utf-8"))

    entries = resource["web-config"]["nginx-static-config"]["enable"]
    assert entries, "web-config must register at least one snippet"
    entry = entries[0]
    assert entry["type"] == "dsm", "the snippet belongs inside DSM's own server block"

    snippet = payload / entry["relpath"]
    assert snippet.is_file(), "relpath must exist inside package.tgz"
    text = snippet.read_text(encoding="utf-8")
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

def test_ui_config_registers_app_and_window(payload, info):
    """DSM resolves dsmappname in ui/config; the window class must be registered too."""
    ui = json.loads((payload / "ui" / "config").read_text(encoding="utf-8"))
    assert "SynologyFrp.js" in ui, "the config must name the JS bundle"
    classes = ui["SynologyFrp.js"]

    assert info["dsmappname"] == "SYNO.SDS.SynologyFrp.Application"

    app = classes[info["dsmappname"]]
    assert app["type"] == "app"
    assert app["allUsers"] is True
    assert app["appWindow"] == "SYNO.SDS.SynologyFrp.MainWindow"

    window = classes[app["appWindow"]]
    assert window["type"] == "lib", "the window class must be registered as lib"


def test_bundle_uses_ext3_idioms(payload):
    """DSM 7.4 ships Ext JS 3.4: Ext.define/callParent resolve to a null superclass."""
    raw = (payload / "ui" / "SynologyFrp.js").read_text(encoding="utf-8")
    # comments explain the Ext 4 pitfalls, so strip them before asserting
    bundle = re.sub(r"/\*.*?\*/", "", raw, flags=re.S)
    bundle = re.sub(r"//[^\n]*", "", bundle)
    bundle = re.sub(r"//[^\n]*", "", bundle)
    assert "Ext.extend(SYNO.SDS.AppInstance" in bundle
    assert "Ext.extend(SYNO.SDS.AppWindow" in bundle
    assert "superclass.constructor.call" in bundle
    assert "callParent" not in bundle, "Ext 3 has no working callParent"
    assert "Ext.define" not in bundle, "Ext.define is Ext 4; DSM ships Ext 3.4"
    assert "Ext.form.field." not in bundle, "that namespace is Ext 4"
    assert "Ext.form.TextArea" not in bundle, "no Ext form widgets inside the window"
    assert "appWindowName" in bundle
    assert "tag: 'iframe'" not in bundle

def test_ui_config_registers_app_and_window(payload, info):
    """DSM resolves dsmappname in ui/config; the window class must be registered too."""
    ui = json.loads((payload / "ui" / "config").read_text(encoding="utf-8"))
    assert "SynologyFrp.js" in ui, "the config must name the JS bundle"
    classes = ui["SynologyFrp.js"]

    assert info["dsmappname"] == "SYNO.SDS.SynologyFrp.Application"

    app = classes[info["dsmappname"]]
    assert app["type"] == "app"
    assert app["allUsers"] is True
    assert app["appWindow"] == "SYNO.SDS.SynologyFrp.MainWindow"

    window = classes[app["appWindow"]]
    assert window["type"] == "lib", "the window class must be registered as lib"


def test_bundle_uses_ext3_idioms(payload):
    """DSM 7.4 ships Ext JS 3.4: Ext.define/callParent resolve to a null superclass."""
    raw = (payload / "ui" / "SynologyFrp.js").read_text(encoding="utf-8")
    # comments explain the Ext 4 pitfalls, so strip them before asserting
    bundle = re.sub(r"/\*.*?\*/", "", raw, flags=re.S)
    bundle = re.sub(r"//[^\n]*", "", bundle)
    bundle = re.sub(r"//[^\n]*", "", bundle)
    assert "Ext.extend(SYNO.SDS.AppInstance" in bundle
    assert "Ext.extend(SYNO.SDS.AppWindow" in bundle
    assert "superclass.constructor.call" in bundle
    assert "callParent" not in bundle, "Ext 3 has no working callParent"
    assert "Ext.define" not in bundle, "Ext.define is Ext 4; DSM ships Ext 3.4"
    assert "Ext.form.field." not in bundle, "that namespace is Ext 4"
    assert "Ext.form.TextArea" not in bundle, "no Ext form widgets inside the window"
    assert "appWindowName" in bundle
    assert "tag: 'iframe'" not in bundle


def test_content_fill_survives_a_field_reset(payload):
    """DSM clears the field after the window is shown; setValue then throws.

    Ext 3's setValue runs the validation chain, and errorMsgEl is undefined once
    the field has been reset, so the value never reaches the textarea.
    """
    bundle = (payload / "ui" / "SynologyFrp.js").read_text(encoding="utf-8")
    assert "applyContent" in bundle
    assert "box.value = text" in bundle, "write the textarea directly"
    assert "userEdited" in bundle, "never overwrite what the user is typing"


def test_content_fill_survives_a_field_reset(payload):
    """DSM clears the field after the window is shown; setValue then throws.

    Ext 3's setValue runs the validation chain, and errorMsgEl is undefined once
    the field has been reset, so the value never reaches the textarea.
    """
    bundle = (payload / "ui" / "SynologyFrp.js").read_text(encoding="utf-8")
    assert "applyContent" in bundle
    assert "box.value = text" in bundle, "write the textarea directly"
    assert "userEdited" in bundle, "never overwrite what the user is typing"


def test_save_is_a_real_button(payload):
    """Ext 3 buttons lose their chrome under the DSM theme: use a real <button>."""
    bundle = (payload / "ui" / "SynologyFrp.js").read_text(encoding="utf-8")
    assert "保存并重启" in bundle
    assert '<button type="button"' in bundle
    assert ".frp-btn{" in bundle
    assert "buttons: [" not in bundle, "Ext 3 button widgets render as bare text in DSM"


def test_save_is_bound_three_ways(payload):
    """DSM's window can swallow bubbling, and getEl() may not reach the footer."""
    bundle = (payload / "ui" / "SynologyFrp.js").read_text(encoding="utf-8")
    assert 'onclick="window.__frpSave' in bundle, "inline bridge"
    assert "document.addEventListener('click'" in bundle, "delegated fallback"
    assert "addEventListener('click'" in bundle, "direct binding on the button"
    assert "if (me.saving) { return; }" in bundle, "one save per click"


def test_footer_is_not_named_footer(payload):
    """Ext 3's Panel uses this.footer internally; shadowing it breaks render."""
    bundle = (payload / "ui" / "SynologyFrp.js").read_text(encoding="utf-8")
    assert "me.footer =" not in bundle
    assert "this.footer =" not in bundle


def test_window_ui_is_plain_dom(payload):
    """Ext widgets lose their chrome in DSM: buttons turn into text and
    Ext.Msg into a grey block with no visible buttons, and the vbox layout
    mispositions children. The window body is therefore plain DOM."""
    raw = (payload / "ui" / "SynologyFrp.js").read_text(encoding="utf-8")
    bundle = re.sub(r"/\*.*?\*/", "", raw, flags=re.S)
    bundle = re.sub(r"//[^\n]*", "", bundle)

    assert "Ext.Msg" not in bundle, "the alert dialog renders as a grey block"
    assert "Ext.form." not in bundle, "no Ext widgets inside the window"
    assert "<textarea" in bundle
    assert "display:flex" in bundle.replace(" ", "")


def test_window_can_show_the_frpc_log(payload):
    """Users need to self-diagnose tunnel problems without SSH."""
    bundle = (payload / "ui" / "SynologyFrp.js").read_text(encoding="utf-8")
    assert "toggleLog" in bundle
    assert 'data-el="log"' in bundle
    assert "'/logs?lines=200'" in bundle
    assert "window.__frpLog" in bundle, "inline bridge for the link"
