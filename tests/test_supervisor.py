import os
import signal

import pytest

from frpui.supervisor import Supervisor


@pytest.fixture
def config_file(tmp_path):
    path = tmp_path / "frpc.toml"
    path.write_text('serverAddr = "127.0.0.1"\n', encoding="utf-8")
    return str(path)


@pytest.fixture
def supervisor(tmp_path, fake_binary):
    sup = Supervisor(str(tmp_path / "var"), binary=str(fake_binary))
    yield sup
    sup.stop()


def test_version_is_reported(supervisor):
    assert supervisor.version() == "0.72.0-fake"


def test_start_and_stop(supervisor, config_file):
    result = supervisor.start(config_file)
    assert result["started"] is True
    assert result["pid"] > 0
    assert supervisor.running() is True
    status = supervisor.status()
    assert status["running"] is True
    assert status["pid"] == result["pid"]

    supervisor.stop()
    assert supervisor.running() is False
    assert supervisor.status()["pid"] == 0


def test_broken_config_reports_the_real_error(supervisor, tmp_path):
    bad = tmp_path / "broken.toml"
    bad.write_text("BROKEN = true\n", encoding="utf-8")
    result = supervisor.start(str(bad))
    assert result["started"] is False
    assert "parse config error" in result["error"]
    assert supervisor.running() is False


def test_error_only_shows_the_current_run(supervisor, tmp_path, config_file):
    os.makedirs(supervisor.log_dir, exist_ok=True)
    with open(supervisor.log_path, "w", encoding="utf-8") as handle:
        handle.write("old noise: connect to server error\n")
    bad = tmp_path / "bad2.toml"
    bad.write_text("BROKEN = 1\n", encoding="utf-8")
    result = supervisor.start(str(bad))
    assert "parse config error" in result["error"]
    assert "old noise" not in result["error"]


def test_ansi_codes_are_stripped(supervisor):
    os.makedirs(supervisor.log_dir, exist_ok=True)
    with open(supervisor.log_path, "w", encoding="utf-8") as handle:
        handle.write("\x1b[1;33mwarning\x1b[0m plain\n")
    assert supervisor.last_lines(5) == ["warning plain"]


def test_error_only_shows_the_current_run(supervisor, tmp_path, config_file):
    os.makedirs(supervisor.log_dir, exist_ok=True)
    with open(supervisor.log_path, "w", encoding="utf-8") as handle:
        handle.write("old noise: connect to server error\n")
    bad = tmp_path / "bad2.toml"
    bad.write_text("BROKEN = 1\n", encoding="utf-8")
    result = supervisor.start(str(bad))
    assert "parse config error" in result["error"]
    assert "old noise" not in result["error"]


def test_ansi_codes_are_stripped(supervisor):
    os.makedirs(supervisor.log_dir, exist_ok=True)
    with open(supervisor.log_path, "w", encoding="utf-8") as handle:
        handle.write("\x1b[1;33mwarning\x1b[0m plain\n")
    assert supervisor.last_lines(5) == ["warning plain"]


def test_missing_binary_is_explained(tmp_path, config_file):
    sup = Supervisor(str(tmp_path / "var"), binary=str(tmp_path / "nope"))
    result = sup.start(config_file)
    assert result["started"] is False
    assert "缺少" in result["error"]


def test_missing_config_is_explained(tmp_path):
    sup = Supervisor(str(tmp_path / "var"), binary=str(tmp_path / "nope"))
    result = sup.start(str(tmp_path / "nope.toml"))
    assert result["started"] is False
    assert result["error"]


def test_restart_changes_pid(supervisor, config_file):
    first = supervisor.start(config_file)
    second = supervisor.restart(config_file)
    assert second["started"] is True
    assert second["pid"] != first["pid"]


def test_log_captures_output(supervisor, config_file):
    supervisor.start(config_file)
    lines = supervisor.last_lines(20)
    assert any("login to server success" in line for line in lines)


def test_log_is_trimmed_to_the_requested_count(supervisor, config_file):
    supervisor.start(config_file)
    assert len(supervisor.last_lines(2)) <= 2


def test_log_rotation_keeps_the_file_bounded(supervisor, config_file):
    os.makedirs(supervisor.log_dir, exist_ok=True)
    with open(supervisor.log_path, "wb") as handle:
        handle.write(b"x" * (3 * 1024 * 1024))
    supervisor.start(config_file)
    assert os.path.getsize(supervisor.log_path) < 3 * 1024 * 1024
    assert os.path.exists(supervisor.log_path + ".1")


def test_stop_is_safe_when_nothing_runs(supervisor):
    assert supervisor.stop() == {"running": False}


def test_connection_state_reflects_the_log(supervisor, config_file):
    assert supervisor.connection_state() is None
    supervisor.start(config_file)
    assert supervisor.connection_state() is True

    os.makedirs(supervisor.log_dir, exist_ok=True)
    with open(supervisor.log_path, "a", encoding="utf-8") as handle:
        handle.write("connect to server error: dial tcp: connection refused\n")
    assert supervisor.connection_state() is False


def test_status_exposes_connection_state(supervisor, config_file):
    supervisor.start(config_file)
    assert supervisor.status()["connected"] is True


def test_connection_state_reflects_the_log(supervisor, config_file):
    assert supervisor.connection_state() is None
    supervisor.start(config_file)
    assert supervisor.connection_state() is True

    os.makedirs(supervisor.log_dir, exist_ok=True)
    with open(supervisor.log_path, "a", encoding="utf-8") as handle:
        handle.write("connect to server error: dial tcp: connection refused\n")
    assert supervisor.connection_state() is False


def test_status_exposes_connection_state(supervisor, config_file):
    supervisor.start(config_file)
    assert supervisor.status()["connected"] is True


def test_status_reports_missing_binary(tmp_path):
    sup = Supervisor(str(tmp_path / "var"), binary=str(tmp_path / "nope"))
    assert sup.status()["binaryPresent"] is False
