import json
import os
import stat

import pytest

from frpui.store import TOML_TEMPLATE, Store, StoreError


def test_first_read_seeds_a_default_file(tmp_path):
    store = Store(str(tmp_path))
    fmt, content = store.current()
    assert fmt == "toml"
    assert "serverAddr" in content
    assert "your-server.example.com" in content
    assert os.path.exists(str(tmp_path / "frpc.toml"))


def test_save_is_private_and_round_trips(tmp_path):
    store = Store(str(tmp_path))
    store.write("toml", 'serverAddr = "nas.example.com"\n')
    path = tmp_path / "frpc.toml"
    assert path.read_text(encoding="utf-8").startswith('serverAddr = "nas.example.com"')
    assert stat.S_IMODE(os.stat(str(path)).st_mode) == 0o600
    assert Store(str(tmp_path)).current()[1].startswith('serverAddr = "nas.example.com"')


def test_content_gets_a_trailing_newline(tmp_path):
    store = Store(str(tmp_path))
    store.write("toml", "serverAddr='x'")
    assert (tmp_path / "frpc.toml").read_text(encoding="utf-8").endswith("\n")


def test_switching_format_removes_the_old_file(tmp_path):
    store = Store(str(tmp_path))
    store.write("toml", "serverAddr = 'x'\n")
    assert (tmp_path / "frpc.toml").exists()

    store.write("ini", "[common]\nserver_addr = x\n")
    assert (tmp_path / "frpc.ini").exists()
    assert not (tmp_path / "frpc.toml").exists()
    assert store.current()[0] == "ini"
    assert json.loads((tmp_path / "config.json").read_text())["format"] == "ini"


def test_empty_content_is_rejected(tmp_path):
    store = Store(str(tmp_path))
    store.write("toml", "serverAddr = 'x'\n")
    with pytest.raises(StoreError) as info:
        store.write("toml", "   \n\n")
    assert info.value.field == "content"
    # the previous good config must survive
    assert "serverAddr" in (tmp_path / "frpc.toml").read_text(encoding="utf-8")


def test_unknown_format_is_rejected(tmp_path):
    store = Store(str(tmp_path))
    with pytest.raises(StoreError):
        store.write("yaml", "serverAddr: x")


def test_templates_cover_both_formats(tmp_path):
    store = Store(str(tmp_path))
    assert "[[proxies]]" in store.template("toml")
    assert "[common]" in store.template("ini")
    assert TOML_TEMPLATE == store.template("toml")


def test_meta_is_inferred_when_missing(tmp_path):
    (tmp_path / "frpc.ini").write_text("[common]\n", encoding="utf-8")
    store = Store(str(tmp_path))
    assert store.load_meta()["format"] == "ini"


def test_no_temp_files_left_behind(tmp_path):
    store = Store(str(tmp_path))
    store.write("toml", "serverAddr = 'x'\n")
    leftovers = [name for name in os.listdir(str(tmp_path)) if name.startswith(".tmp-")]
    assert leftovers == []
