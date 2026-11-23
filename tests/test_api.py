import os


def test_state_seeds_default_config(client):
    status, body = client.get("/api/state")
    assert status == 200
    assert body["format"] == "toml"
    assert body["fileName"] == "frpc.toml"
    assert "serverAddr" in body["content"]
    assert body["status"]["running"] is False


def test_health(client):
    status, body = client.get("/api/health")
    assert status == 200
    assert body["status"] == "ok"


def test_save_writes_and_starts(client):
    content = 'serverAddr = "nas.example.com"\nserverPort = 7000\n'
    status, body = client.put("/api/file", {"format": "toml", "content": content})
    assert status == 200, body
    assert body["saved"] is True
    assert body["started"] is True
    assert body["state"]["status"]["running"] is True
    with open(client.path("frpc.toml"), "r", encoding="utf-8") as handle:
        assert handle.read().startswith('serverAddr = "nas.example.com"')

    status, again = client.get("/api/state")
    assert again["content"].startswith('serverAddr = "nas.example.com"')
    assert again["status"]["running"] is True


def test_save_broken_config_keeps_content_and_reports_failure(client):
    status, body = client.put("/api/file", {"format": "toml", "content": "BROKEN = 1\n"})
    assert status == 200
    assert body["saved"] is True
    assert body["started"] is False
    assert "parse config error" in body["error"]
    assert body["state"]["status"]["running"] is False
    # the user's text is not thrown away
    with open(client.path("frpc.toml"), "r", encoding="utf-8") as handle:
        assert "BROKEN" in handle.read()


def test_empty_content_is_rejected(client):
    client.put("/api/file", {"format": "toml", "content": 'serverAddr = "x"\n'})
    status, body = client.put("/api/file", {"format": "toml", "content": "   "})
    assert status == 422
    assert body["code"] == "INVALID_CONFIG"
    assert body["field"] == "content"
    with open(client.path("frpc.toml"), "r", encoding="utf-8") as handle:
        assert 'serverAddr = "x"' in handle.read()


def test_switching_format_replaces_the_file(client):
    client.put("/api/file", {"format": "toml", "content": 'serverAddr = "x"\n'})
    status, body = client.put("/api/file", {
        "format": "ini",
        "content": "[common]\nserver_addr = x\nserver_port = 7000\n",
    })
    assert status == 200
    assert body["state"]["format"] == "ini"
    assert body["state"]["fileName"] == "frpc.ini"
    assert os.path.exists(client.path("frpc.ini"))
    assert not os.path.exists(client.path("frpc.toml"))


def test_start_stop_restart(client):
    client.put("/api/file", {"format": "toml", "content": 'serverAddr = "x"\n'})
    _, state = client.get("/api/state")
    first_pid = state["status"]["pid"]

    status, body = client.post("/api/stop")
    assert status == 200
    assert body["state"]["status"]["running"] is False

    status, body = client.post("/api/start")
    assert body["started"] is True
    assert body["state"]["status"]["running"] is True

    status, body = client.post("/api/restart")
    assert body["started"] is True
    assert body["state"]["status"]["pid"] != first_pid


def test_logs_are_available(client):
    client.put("/api/file", {"format": "toml", "content": 'serverAddr = "x"\n'})
    status, body = client.get("/api/logs?lines=20")
    assert status == 200
    assert body["path"].endswith("frpc.log")
    assert any("login to server success" in line for line in body["lines"])


def test_template_endpoint(client):
    status, body = client.get("/api/template?format=ini")
    assert status == 200
    assert "[common]" in body["content"]

    status, body = client.get("/api/template?format=nope")
    assert status == 422


def test_unknown_api_is_json_404(client):
    status, body = client.get("/api/nope")
    assert status == 404
    assert body["code"] == "NOT_FOUND"
