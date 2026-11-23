/* FRP client - one screen: status, editor, log. */
(function () {
  'use strict';

  var API = 'api';
  var POLL_MS = 3000;

  var state = {
    loaded: false,
    offline: false,
    offlineDetail: '',
    data: null,
    logs: [],
    logPath: '',
    notice: null,
    busy: false,
    timer: null
  };

  var mainEl = document.getElementById('main');
  var statusEl = document.getElementById('status');

  // ---------------------------------------------------------------- utils
  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function api(method, path, body) {
    var options = { method: method, credentials: 'same-origin', headers: { 'Accept': 'application/json' } };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return fetch(API + path, options).then(function (response) {
      return response.text().then(function (text) {
        var data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch (err) {
          data = { code: 'BAD_RESPONSE', message: '返回内容无法解析' };
        }
        if (!response.ok) {
          var error = new Error(data.message || ('请求失败（' + response.status + '）'));
          error.code = data.code;
          error.status = response.status;
          throw error;
        }
        return data;
      });
    });
  }

  function duration(seconds) {
    var value = Number(seconds) || 0;
    if (value < 60) { return value + ' 秒'; }
    var minutes = Math.floor(value / 60);
    if (minutes < 60) { return minutes + ' 分钟'; }
    var hours = Math.floor(minutes / 60);
    if (hours < 24) { return hours + ' 小时 ' + (minutes % 60) + ' 分'; }
    return Math.floor(hours / 24) + ' 天 ' + (hours % 24) + ' 小时';
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    api('GET', '/state').then(function (data) {
      state.offline = false;
      state.loaded = true;
      state.data = data;
      return loadLogs();
    }).then(function () {
      render();
      startPolling();
    }).catch(function (error) {
      if (!error.status || error.status === 404) {
        state.offline = true;
        state.offlineDetail = error.message || '';
        stopPolling();
        render();
        return;
      }
      state.loaded = true;
      state.notice = { kind: 'error', title: '读取失败', message: error.message };
      render();
    });
  }

  function loadLogs() {
    return api('GET', '/logs?lines=80').then(function (data) {
      state.logs = data.lines || [];
      state.logPath = data.path || '';
    }).catch(function () {
      state.logs = [];
    });
  }

  function reload(notice) {
    return api('GET', '/state').then(function (data) {
      state.data = data;
      if (notice) { state.notice = notice; }
      return loadLogs();
    }).then(function () {
      render();
    }).catch(function (error) {
      state.notice = { kind: 'error', title: '刷新失败', message: error.message };
      render();
    });
  }

  // ---------------------------------------------------------------- render
  function statusText() {
    var status = (state.data && state.data.status) || {};
    if (!status.running) { return '已停止'; }
    var conn = '';
    if (status.connected === false) {
      conn = ' · 未连上服务器';
    } else if (status.connected === true) {
      conn = ' · 已连上';
    }
    return '运行中' + conn + (status.version ? ' · v' + status.version : '') +
      ' · 已运行 ' + duration(status.uptime);
  }

  function statusDot() {
    var status = (state.data && state.data.status) || {};
    if (!status.running) { return 'bad'; }
    return status.connected === false ? 'warn' : 'ok';
  }

  function renderStatus() {
    statusEl.innerHTML = '<span class="dot ' + statusDot() + '"></span>' + esc(statusText());
  }

  function noticeHtml() {
    if (!state.notice) { return ''; }
    var body = '<div class="alert ' + esc(state.notice.kind || 'ok') + '">' +
      '<div class="title">' + esc(state.notice.title || '') + '</div>';
    if (state.notice.message) { body += esc(state.notice.message); }
    if (state.notice.detail) { body += '<pre>' + esc(state.notice.detail) + '</pre>'; }
    return body + '</div>';
  }

  function viewOffline() {
    return '<div class="card">' +
      '<h2>连不上套件的后台服务</h2>' +
      '<p class="sub">窗口能打开，但后台没有响应。通常是后台没启动，或 DSM 的反向代理没生效。</p>' +
      '<div class="alert warn"><div class="title">按顺序排查</div>' +
      '<ol><li>套件中心 → 已安装，确认本套件是「运行中」。</li>' +
      '<li>SSH 里执行 <code>curl -s localhost:9844/api/health</code>，有 JSON 回来说明后台正常。</li>' +
      '<li>把下面的配置追加到 <code>/etc/nginx/conf.d/http.synology-frp.conf</code>，再 <code>nginx -t &amp;&amp; nginx -s reload</code>：</li></ol>' +
      '<pre>location ^~ /webman/3rdparty/synology-frp/api/ {\n    proxy_pass http://127.0.0.1:9844/api/;\n    proxy_set_header Host $host;\n}</pre>' +
      '</div>' +
      '<div class="actions"><button class="primary" type="button" id="retry">重新连接</button></div>' +
      (state.offlineDetail ? '<p class="sub" style="margin-top:10px">技术细节：' + esc(state.offlineDetail) + '</p>' : '') +
      '</div>';
  }

  function viewMain() {
    var data = state.data || {};
    var status = data.status || {};
    var formats = data.formats || ['toml', 'ini'];
    var options = formats.map(function (item) {
      var label = item === 'toml' ? 'TOML（推荐）' : 'INI（旧格式）';
      return '<option value="' + esc(item) + '"' + (item === data.format ? ' selected' : '') + '>' +
        label + '</option>';
    }).join('');

    var logText = state.logs.length ? esc(state.logs.join('\n')) : '<span class="empty">还没有日志</span>';

    return '<div class="card">' +
      '<h2>frpc 配置</h2>' +
      '<p class="sub">改完点「保存并重启」，frpc 会用新配置重新启动。当前文件：<code>' +
      esc(data.fileName || 'frpc.toml') + '</code></p>' +
      noticeHtml() +
      '<div class="toolbar">' +
      '  <select id="f-format" title="配置格式">' + options + '</select>' +
      '  <span class="hint">切换格式会载入该格式的示例，保存后才真正写盘</span>' +
      '  <span class="spacer"></span>' +
      '  <button class="ghost" type="button" id="btn-start"' + (status.running ? ' disabled' : '') + '>启动</button>' +
      '  <button class="ghost" type="button" id="btn-stop"' + (status.running ? '' : ' disabled') + '>停止</button>' +
      '  <button class="ghost" type="button" id="btn-restart">重启</button>' +
      '</div>' +
      '<textarea id="f-content" spellcheck="false">' + esc(data.content || '') + '</textarea>' +
      '<div class="actions">' +
      '  <button class="primary" type="button" id="btn-save">保存并重启</button>' +
      '  <span class="hint" id="save-state"></span>' +
      (status.binaryPresent === false ? '<span class="hint" style="color:var(--danger)">套件里缺少 frpc 可执行文件</span>' : '') +
      '</div>' +
      '</div>' +
      '<div class="card">' +
      '<h2>最近日志</h2>' +
      '<p class="sub">frpc 的输出（stdout / stderr），用来排查连不上或配置写错。</p>' +
      '<div class="toolbar"><button class="ghost" type="button" id="btn-logs">刷新日志</button></div>' +
      '<pre class="log" id="f-log">' + logText + '</pre>' +
      '<div class="logpath">' + esc(state.logPath || '') + '</div>' +
      '</div>';
  }

  function render() {
    renderStatus();
    if (state.offline) {
      mainEl.innerHTML = viewOffline();
      bind('retry', boot);
      return;
    }
    if (!state.loaded) {
      mainEl.innerHTML = '<div class="card"><div class="empty">正在加载…</div></div>';
      return;
    }
    mainEl.innerHTML = viewMain();
    wire();
  }

  function bind(id, handler) {
    var node = document.getElementById(id);
    if (node) { node.addEventListener('click', handler); }
  }

  // ---------------------------------------------------------------- actions
  function wire() {
    bind('btn-save', function (event) { save(event.target); });
    bind('btn-restart', function () { action('restart', '已重启'); });
    bind('btn-stop', function () { action('stop', '已停止'); });
    bind('btn-start', function () { action('start', '已启动'); });
    bind('btn-logs', function () {
      loadLogs().then(function () { render(); });
    });

    var formatNode = document.getElementById('f-format');
    if (formatNode) {
      formatNode.addEventListener('change', function () {
        var target = formatNode.value;
        if (state.data && target === state.data.format) { return; }
        if (!window.confirm('切换格式会把这个格式的示例填进编辑器（保存后才写盘）。继续？')) {
          formatNode.value = state.data ? state.data.format : 'toml';
          return;
        }
        api('GET', '/template?format=' + encodeURIComponent(target)).then(function (data) {
          var editor = document.getElementById('f-content');
          if (editor) { editor.value = data.content || ''; }
          state.notice = {
            kind: 'warn', title: '已载入 ' + (target === 'ini' ? 'INI' : 'TOML') + ' 示例',
            message: '确认内容后点「保存并重启」，旧格式文件会被移除。'
          };
          render();
          var next = document.getElementById('f-format');
          if (next) { next.value = target; }
        }).catch(function (error) {
          state.notice = { kind: 'error', title: '载入示例失败', message: error.message };
          render();
        });
      });
    }
  }

  function action(kind, okMessage) {
    if (state.busy) { return; }
    state.busy = true;
    state.notice = null;
    api('POST', '/' + kind).then(function (data) {
      state.busy = false;
      var notice = { kind: 'ok', title: okMessage, message: '' };
      if (data.started === false) {
        notice = { kind: 'error', title: '启动失败', message: '', detail: data.error || '' };
      }
      return reload(notice);
    }).catch(function (error) {
      state.busy = false;
      state.notice = { kind: 'error', title: '操作失败', message: error.message };
      render();
    });
  }

  function save(button) {
    var editor = document.getElementById('f-content');
    var formatNode = document.getElementById('f-format');
    var label = document.getElementById('save-state');
    if (!editor) { return; }

    button.disabled = true;
    if (label) { label.textContent = '保存中…'; }
    state.busy = true;
    state.notice = null;

    api('PUT', '/file', {
      format: formatNode ? formatNode.value : 'toml',
      content: editor.value
    }).then(function (data) {
      state.busy = false;
      button.disabled = false;
      if (label) { label.textContent = ''; }
      var notice = data.started
        ? { kind: 'ok', title: '已保存并重启', message: '配置已生效。' }
        : { kind: 'error', title: '已保存，但启动失败', message: '', detail: data.error || '' };
      return reload(notice);
    }).catch(function (error) {
      state.busy = false;
      button.disabled = false;
      if (label) { label.textContent = ''; }
      state.notice = { kind: 'error', title: '保存失败', message: error.message };
      render();
    });
  }

  // ---------------------------------------------------------------- polling
  function startPolling() {
    if (state.timer) { return; }
    state.timer = setInterval(function () {
      if (state.offline || state.busy) { return; }
      api('GET', '/state').then(function (data) {
        state.data = data;
        renderStatus();
      }).catch(function () {
        /* keep the last known status; the next real action will surface errors */
      });
    }, POLL_MS);
  }

  function stopPolling() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
