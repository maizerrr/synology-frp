/* FRP 客户端 —— DSM 原生窗口。
 *
 * DSM 7.2 起桌面与任务栏是 Vue 的：ExtJS 的 AppWindow 关不掉也注册不上
 * （taskbar 报 closeWindow 读到 null）。这里按官方示例走 Vue：
 *   Vue.extend -> <v-app-instance> -> <v-app-window>
 * 窗口内容用纯 DOM 渲染（不用 iframe），数据经同源反代访问包内后端。
 */
(function () {
    'use strict';

    var NS = 'SYNO.SDS.SynologyFrp';
    var API = '/webman/3rdparty/synology-frp/api';

    SYNO.namespace(NS);

    var CSS = [
        '.frp-root{display:flex;flex-direction:column;height:100%;width:100%;',
        'background:#f2f4f7;font:13px/1.5 -apple-system,"Segoe UI","PingFang SC",sans-serif;color:#1d2129;}',
        '.frp-bar{display:flex;align-items:center;gap:8px;padding:6px 10px;background:#fff;',
        'border-bottom:1px solid #e2e6ec;flex:0 0 auto;}',
        '.frp-dot{width:8px;height:8px;border-radius:50%;background:#c9ced6;}',
        '.frp-dot.ok{background:#34a853;}',
        '.frp-dot.bad{background:#d93025;}',
        '.frp-dot.warn{background:#f0a020;}',
        '.frp-grow{flex:1 1 auto;}',
        '.frp-bar select,.frp-bar input{padding:3px 6px;border:1px solid #e2e6ec;border-radius:4px;',
        'background:#fff;font-family:inherit;font-size:12px;}',
        '.frp-bar button,.frp-head button{padding:4px 10px;border:1px solid #e2e6ec;border-radius:4px;',
        'background:#fff;font-family:inherit;font-size:12px;cursor:pointer;}',
        '.frp-bar button:hover,.frp-head button:hover{background:#f5f7fa;}',
        '.frp-bar button[disabled]{opacity:.45;cursor:default;}',
        '.frp-head button.primary{background:#1f7ae0;border-color:#1f7ae0;color:#fff;}',
        '.frp-head button.primary:hover{background:#1565d8;}',
        '.frp-editor{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;padding:8px 10px 0;}',
        '.frp-head{display:flex;align-items:center;gap:8px;padding:2px 0 6px;color:#6b7280;font-size:12px;}',
        '.frp-editor textarea{flex:1 1 auto;width:100%;min-height:0;box-sizing:border-box;',
        'font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;padding:8px 10px;',
        'border:1px solid #e2e6ec;border-radius:6px;background:#fff;color:#1d2129;resize:none;}',
        '.frp-editor textarea:focus{outline:none;border-color:#1f7ae0;}',
        '.frp-log{flex:0 0 210px;display:flex;flex-direction:column;padding:8px 10px 10px;min-height:0;}',
        '.frp-log pre{flex:1 1 auto;margin:0;overflow:auto;padding:8px 10px;border-radius:6px;',
        'background:#0f1419;color:#d7e0ea;font:11px/1.6 ui-monospace,Menlo,Consolas,monospace;',
        'white-space:pre-wrap;word-break:break-word;}'
    ].join('');

    var HTML = [
        '<div class="frp-root">',
        '  <div class="frp-bar">',
        '    <span class="frp-dot" data-el="dot"></span>',
        '    <span data-el="status">正在读取状态…</span>',
        '    <span class="frp-grow"></span>',
        '    <select data-el="format"><option value="toml">TOML</option><option value="ini">INI（旧格式）</option></select>',
        '    <button data-el="start" type="button">启动</button>',
        '    <button data-el="stop" type="button">停止</button>',
        '    <button data-el="restart" type="button">重启</button>',
        '  </div>',
        '  <div class="frp-editor">',
        '    <div class="frp-head">frpc 配置（保存后会自动重启）<span class="frp-grow"></span>',
        '      <button data-el="save" class="primary" type="button">保存并重启</button></div>',
        '    <textarea data-el="content" spellcheck="false"></textarea>',
        '  </div>',
        '  <div class="frp-log">',
        '    <div class="frp-head">最近日志<span class="frp-grow"></span>',
        '      <button data-el="logs" type="button">刷新日志</button></div>',
        '    <pre data-el="log"></pre>',
        '  </div>',
        '</div>'
    ].join('');

    // ---------------------------------------------------------------- helpers
    function request(method, path, payload) {
        var options = { method: method, credentials: 'same-origin', headers: { 'Accept': 'application/json' } };
        if (payload !== undefined) {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(payload);
        }
        return fetch(API + path, options).then(function (response) {
            return response.text().then(function (text) {
                var data = {};
                try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { message: '返回内容无法解析' }; }
                if (!response.ok) {
                    var error = new Error(data.message || ('请求失败（' + response.status + '）'));
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
        if (hours < 24) { return hours + ' 小时'; }
        return Math.floor(hours / 24) + ' 天';
    }

    function offlineText(error) {
        return '连不上套件的后台服务（' + (error && error.message ? error.message : '未知错误') + '）。\n\n' +
            '1) 套件中心 → 已安装，确认本套件为「运行中」；\n' +
            '2) SSH 执行 curl -s localhost:9844/api/health，有 JSON 回来说明后台正常；\n' +
            '3) 后台正常仍报错，说明 DSM 反代没生效，把下面加到 /etc/nginx/conf.d/http.synology-frp.conf 后 nginx -s reload：\n' +
            'location ^~ /webman/3rdparty/synology-frp/api/ {\n' +
            '    proxy_pass http://127.0.0.1:9844/api/;\n' +
            '    proxy_set_header Host $host;\n' +
            '}';
    }

    // ------------------------------------------------------------------ window
    SYNO.SDS.SynologyFrp.Instance = Vue.extend({
        render: function (h) {
            return h('v-app-instance', {
                attrs: { 'class-name': NS + '.Instance' }
            }, [
                h('v-app-window', {
                    ref: 'appWindow',
                    attrs: { width: 1000, height: 680, 'syno-id': NS + '.Window' }
                }, [
                    h('div', {
                        ref: 'root',
                        domProps: { innerHTML: '<style>' + CSS + '</style>' + HTML }
                    })
                ])
            ]);
        },

        mounted: function () {
            this.start();
        },

        beforeDestroy: function () {
            if (this.timer) { window.clearInterval(this.timer); this.timer = null; }
        },

        methods: {
            start: function () {
                var root = this.$refs.root;
                if (!root) { return; }
                var me = this;
                this.el = {};
                ['dot', 'status', 'format', 'start', 'stop', 'restart', 'save', 'content', 'logs', 'log']
                    .forEach(function (name) {
                        me.el[name] = root.querySelector('[data-el="' + name + '"]');
                    });

                this.el.save.addEventListener('click', function () { me.save(); });
                this.el.start.addEventListener('click', function () { me.action('start'); });
                this.el.stop.addEventListener('click', function () { me.action('stop'); });
                this.el.restart.addEventListener('click', function () { me.action('restart'); });
                this.el.logs.addEventListener('click', function () { me.loadLogs(); });
                this.el.format.addEventListener('change', function () { me.onFormatChange(me.el.format.value); });

                this.ready = false;
                this.loadState().then(function () {
                    me.ready = true;
                    me.loadLogs();
                }).catch(function (error) {
                    me.setStatus('未连接后台服务', 'bad');
                    window.alert(offlineText(error));
                });

                this.timer = window.setInterval(function () { me.poll(); }, 3000);
            },

            loadState: function () {
                var me = this;
                return request('GET', '/state').then(function (data) {
                    me.el.format.value = data.format || 'toml';
                    if (!me.el.content.value) { me.el.content.value = data.content || ''; }
                    me.applyStatus(data.status || {});
                    return data;
                });
            },

            poll: function () {
                var me = this;
                if (!this.el) { return; }
                request('GET', '/state').then(function (data) {
                    me.applyStatus(data.status || {});
                }).catch(function () {
                    me.setStatus('未连接后台服务', 'bad');
                });
            },

            setStatus: function (text, tone) {
                if (!this.el) { return; }
                this.el.status.textContent = text;
                this.el.dot.className = 'frp-dot' + (tone ? ' ' + tone : '');
            },

            applyStatus: function (status) {
                var me = this;
                if (!status.running) {
                    me.setStatus('已停止', 'bad');
                    me.el.start.disabled = false;
                    me.el.stop.disabled = true;
                    me.el.restart.disabled = false;
                    return;
                }
                var text = '运行中';
                var tone = 'ok';
                if (status.connected === false) {
                    text += ' · 未连上服务器';
                    tone = 'warn';
                } else if (status.connected === true) {
                    text += ' · 已连上';
                }
                if (status.version) { text += ' · v' + status.version; }
                text += ' · 已运行 ' + duration(status.uptime);
                me.setStatus(text, tone);
                me.el.start.disabled = true;
                me.el.stop.disabled = false;
                me.el.restart.disabled = false;
            },

            save: function () {
                var me = this;
                var content = me.el.content.value;
                if (!content || !content.replace(/\s/g, '')) {
                    window.alert('配置内容不能为空。');
                    return;
                }
                request('PUT', '/file', { format: me.el.format.value || 'toml', content: content })
                    .then(function (data) {
                        if (data.state && data.state.content) { me.el.content.value = data.state.content; }
                        if (data.started) {
                            window.alert('已保存并重启，配置已生效。');
                        } else {
                            window.alert('已保存，但启动失败：\n' + (data.error || '请查看下方日志。'));
                        }
                        me.loadState();
                        me.loadLogs();
                    })
                    .catch(function (error) { window.alert('保存失败：' + error.message); });
            },

            action: function (kind) {
                var me = this;
                request('POST', '/' + kind).then(function (data) {
                    if (data.started === false) {
                        window.alert('启动失败：\n' + (data.error || ''));
                    } else if (data.state) {
                        me.applyStatus(data.state.status || {});
                    }
                    me.loadLogs();
                }).catch(function (error) { window.alert('操作失败：' + error.message); });
            },

            loadLogs: function () {
                var me = this;
                request('GET', '/logs?lines=80').then(function (data) {
                    me.el.log.textContent = (data.lines || []).join('\n');
                }).catch(function () {
                    me.el.log.textContent = '（日志读取失败）';
                });
            },

            onFormatChange: function (value) {
                var me = this;
                if (!this.ready || !value) { return; }
                request('GET', '/template?format=' + encodeURIComponent(value)).then(function (data) {
                    me.el.content.value = data.content || '';
                    window.alert('已载入 ' + value.toUpperCase() + ' 示例。确认后点「保存并重启」，旧格式文件会被移除。');
                }).catch(function (error) { window.alert('载入示例失败：' + error.message); });
            }
        }
    });
}());
