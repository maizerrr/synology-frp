/* FRP 客户端 —— DSM 原生窗口。
 *
 * 事实（在 DSM 7.4 上实测得来，都是踩过的坑）：
 *   - DSM 桌面加载的是 Ext JS 3.4.0（/scripts/ext-3/ext-all.js），不是 Ext 4。
 *     必须 Ext.extend + superclass.constructor.call；Ext.define / callParent
 *     会拿到 null 的父类（报 "Cannot read properties of null"）。
 *   - Ext 3 的按钮/表单/弹窗在 DSM 主题下会失去样式（按钮变纯文字、
 *     Ext.Msg 只剩一个灰块），vbox 布局用绝对定位算高度，多一个元素就错位。
 *     所以窗口内**不用任何 Ext 控件**，整块界面是纯 DOM + flex；Ext 只提供窗口外壳。
 *   - 窗口创建失败时 DSM 会留下一个永远 loading 的任务栏标签，所以不吞异常。
 */
(function () {
    'use strict';

    var NS = 'SYNO.SDS.SynologyFrp';
    var ASSET = '/webman/3rdparty/synology-frp/';
    var API = ASSET + 'api';

    Ext.namespace('SYNO.SDS.SynologyFrp');

    console.log('[frp] runtime', {
        ext: Ext.version,
        appInstance: typeof SYNO.SDS.AppInstance,
        appWindow: typeof SYNO.SDS.AppWindow,
        windowMgr: typeof SYNO.SDS.WindowMgr,
        taskBar: typeof SYNO.SDS.TaskBar
    });

    // ---------------------------------------------------------------- helpers
    var CSS = [
        '.frp-root{display:flex;flex-direction:column;height:100%;box-sizing:border-box;',
        'padding:16px 18px;background:#fff;color:#1d2129;',
        'font:13px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;}',
        '.frp-logo{text-align:center;padding:2px 0 10px;line-height:0}',
        '.frp-logo img{width:88px;height:88px;border-radius:44px}',
        '.frp-hint{text-align:center;color:#5c6672;padding:0 0 10px}',
        '.frp-status{display:flex;align-items:center;gap:10px;color:#8a929c;',
        'font-size:12px;padding:0 0 8px}',
        '.frp-status span{flex:1 1 auto;min-width:0}',
        '.frp-link{color:#1f7ae0;text-decoration:none;cursor:pointer;font-size:12px;',
        'flex:0 0 auto}',
        '.frp-link:hover{text-decoration:underline}',
        '.frp-log{max-height:150px;overflow:auto;margin:8px 0 0;padding:8px 10px;',
        'border-radius:4px;background:#0f1419;color:#d7e0ea;',
        'font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;',
        'word-break:break-word;}',
        '.frp-editor{flex:1 1 auto;min-height:0;width:100%;box-sizing:border-box;',
        'border:1px solid #c9d1d9;border-radius:4px;padding:8px 10px;background:#fff;',
        'color:#1d2129;font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;resize:none;',
        'outline:none;}',
        '.frp-editor:focus{border-color:#1f7ae0}',
        '.frp-toast{margin:8px 0 0;padding:8px 12px;border-radius:4px;font-size:12px;',
        'line-height:1.6;white-space:pre-wrap;word-break:break-word;}',
        '.frp-toast.ok{background:#eaf7ee;border:1px solid #b7e0c3;color:#1e6b32}',
        '.frp-toast.bad{background:#fdecea;border:1px solid #f5c2bd;color:#a4291e}',
        '.frp-footer{text-align:center;padding:12px 0 0;flex:0 0 auto}',
        '.frp-btn{min-width:112px;height:30px;padding:0 18px;border-radius:4px;',
        'border:1px solid #1f7ae0;background:#1f7ae0;color:#fff;cursor:pointer;',
        'font:13px/1.4 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;}',
        '.frp-btn:hover{background:#1565d8;border-color:#1565d8}',
        '.frp-btn:active{background:#0f56bd;border-color:#0f56bd}',
        '.frp-btn[disabled]{opacity:.5;cursor:default}'
    ].join('');

    function ensureStyle() {
        if (document.getElementById('frp-window-style')) { return; }
        // 不要用 document.createElement：Ext 3 覆写了它，传字符串会抛
        // "parameter 1 is not of type 'Node'"。
        var head = document.getElementsByTagName('head')[0] || document.body;
        Ext.DomHelper.append(head, { tag: 'style', id: 'frp-window-style', html: CSS });
    }

    var HTML = [
        '<div class="frp-root">',
        '  <div class="frp-logo"><img src="' + ASSET + 'images/icon_256.png" alt=""></div>',
        '  <div class="frp-hint">套件全局参数配置，保存后会自动重启套件生效！！！</div>',
        '  <div class="frp-status">',
        '    <span data-el="status">正在读取状态…</span>',
        '    <a class="frp-link" data-el="logtoggle" href="#" onclick="window.__frpLog&&window.__frpLog();return false;">日志</a>',
        '  </div>',
        '  <textarea class="frp-editor" data-el="content" spellcheck="false" wrap="off"></textarea>',
        '  <pre class="frp-log" data-el="log" style="display:none"></pre>',
        '  <div class="frp-toast" data-el="toast" style="display:none"></div>',
        '  <div class="frp-footer">',
        '    <button type="button" class="frp-btn" data-el="save"',
        '      onclick="window.__frpSave&&window.__frpSave();return false;">保存并重启</button>',
        '  </div>',
        '</div>'
    ].join('');

    function duration(seconds) {
        var value = Number(seconds) || 0;
        if (value < 60) { return value + ' 秒'; }
        var minutes = Math.floor(value / 60);
        if (minutes < 60) { return minutes + ' 分钟'; }
        var hours = Math.floor(minutes / 60);
        if (hours < 24) { return hours + ' 小时'; }
        return Math.floor(hours / 24) + ' 天';
    }

    function statusText(status) {
        if (!status || !status.running) { return '当前状态：已停止'; }
        var text = '当前状态：运行中';
        if (status.connected === false) {
            text += '（未连上服务器）';
        } else if (status.connected === true) {
            text += '（已连上）';
        }
        if (status.version) { text += ' · v' + status.version; }
        return text + ' · 已运行 ' + duration(status.uptime);
    }

    function synoToken() {
        try {
            if (SYNO.SDS.Session && SYNO.SDS.Session.SynoToken) {
                return SYNO.SDS.Session.SynoToken;
            }
        } catch (e) { /* ignore */ }
        return '';
    }

    function request(method, path, payload, onOk, onFail) {
        var options = {
            url: API + path,
            method: method,
            headers: { 'Accept': 'application/json' },
            success: function (response) {
                var data = {};
                try { data = response.responseText ? Ext.decode(response.responseText) : {}; } catch (e) { data = {}; }
                if (onOk) { onOk(data); }
            },
            failure: function (response) {
                var data = {};
                try { data = response.responseText ? Ext.decode(response.responseText) : {}; } catch (e) { data = {}; }
                if (onFail) { onFail(data.message || ('请求失败（HTTP ' + response.status + '）')); }
            }
        };
        var token = synoToken();
        if (token) { options.headers.SynoToken = token; }
        if (payload !== undefined) {
            options.headers['Content-Type'] = 'application/json';
            options.jsonData = payload;
        }
        Ext.Ajax.request(options);
    }

    // ------------------------------------------------------------ application
    SYNO.SDS.SynologyFrp.Application = Ext.extend(SYNO.SDS.AppInstance, {
        appWindowName: NS + '.MainWindow',

        constructor: function (config) {
            // Ext 3 的父类构造调用；不能写 this.callParent()
            SYNO.SDS.SynologyFrp.Application.superclass.constructor.call(this, config);
        }
    });

    // ----------------------------------------------------------------- window
    SYNO.SDS.SynologyFrp.MainWindow = Ext.extend(SYNO.SDS.AppWindow, {

        constructor: function (config) {
            config = config || {};
            var me = this;
            me.appInstance = config.appInstance || me.appInstance;
            ensureStyle();

            config = Ext.apply({
                width: 760,
                height: 520,
                layout: 'fit',
                html: HTML
            }, config);

            SYNO.SDS.SynologyFrp.MainWindow.superclass.constructor.call(this, config);

            me.on('afterrender', function () {
                var saveBtn = me.node('save');
                if (saveBtn) {
                    saveBtn.addEventListener('click', function (event) {
                        event.preventDefault();
                        me.save();
                    });
                }
                var box = me.node('content');
                if (box) {
                    box.addEventListener('input', function () { me.userEdited = true; });
                }
                me.load();
            });

            me.saveClickHandler = function (event) {
                var node = event.target;
                var marker = node && node.getAttribute && node.getAttribute('data-el');
                if (marker === 'save') {
                    event.preventDefault();
                    me.save();
                } else if (marker === 'logtoggle') {
                    event.preventDefault();
                    me.toggleLog();
                }
            };
            document.addEventListener('click', me.saveClickHandler);
            // 内联 onclick 走这个桥；不依赖 DOM 层级，也不怕事件冒泡被拦
            window.__frpSave = function () { me.save(); };
            window.__frpLog = function () { me.toggleLog(); };

            me.pollId = window.setInterval(function () { me.refreshStatus(); }, 5000);
        },

        // 惰性解析窗口内的节点：DSM 的 AppWindow 不保证 this.body 就是容器，
        // 所以先按 body → getEl() → document 的顺序找，找到就缓存。
        node: function (name) {
            var cache = this.elCache || (this.elCache = {});
            if (cache[name]) { return cache[name]; }
            var selector = '[data-el="' + name + '"]';
            var root = (this.body && this.body.dom) || (this.getEl() && this.getEl().dom);
            var found = null;
            try {
                found = root ? root.querySelector(selector) : null;
            } catch (e) { found = null; }
            if (!found) { found = document.querySelector(selector); }
            if (found) { cache[name] = found; }
            return found;
        },

        load: function () {
            var me = this;
            request('GET', '/state', undefined, function (data) {
                me.applyContent(data);
                me.showStatus(data.status);
                // 窗口刚打开时 DSM 可能还在调整布局，补两次兜底；
                // applyContent 只在框里还是空的时候才写，不会打架。
                Ext.defer(function () { me.applyContent(data); }, 300);
                Ext.defer(function () { me.applyContent(data); }, 900);
            }, function (message) {
                me.showStatusText('未连接后台服务：' + message);
            });
        },

        // 只在内容还是空的时候填；用户动过就不再碰
        applyContent: function (data) {
            var me = this;
            var text = (data && typeof data.content === 'string') ? data.content : '';
            if (!text) { return; }
            me.desiredContent = text;
            var box = me.node('content');
            if (!box) { return; }
            if (me.userEdited) { return; }
            if (box.value === text || box.value !== '') { return; }
            box.value = text;
        },

        refreshStatus: function () {
            var me = this;
            if (me.destroyed) { return; }
            request('GET', '/state', undefined, function (data) {
                me.applyContent(data);
                me.showStatus(data.status);
            }, function () {
                me.showStatusText('未连接后台服务');
            });
        },

        showStatus: function (status) {
            this.showStatusText(statusText(status));
        },

        showStatusText: function (text) {
            var el = this.node('status');
            if (el) { el.textContent = text; }
        },

        // Ext.Msg 在 DSM 主题下只有一个灰块、按钮看不见，所以提示用窗口内的
        // 一行内联消息，不依赖任何 Ext 控件。
        showToast: function (text, tone) {
            var box = this.node('toast');
            if (!box) { return; }
            box.className = 'frp-toast ' + (tone || 'ok');
            box.textContent = text;
            box.style.display = 'block';
            if (this.toastTimer) { window.clearTimeout(this.toastTimer); this.toastTimer = null; }
            if (tone !== 'bad') {
                this.toastTimer = window.setTimeout(function () {
                    if (box) { box.style.display = 'none'; }
                }, 6000);
            }
        },

        toggleLog: function () {
            var me = this;
            // 链接同时挂了内联 onclick 和 document 委托，会触发两次（一开一关）
            var now = new Date().getTime();
            if (me.logToggleAt && now - me.logToggleAt < 150) { return; }
            me.logToggleAt = now;
            var box = me.node('log');
            if (!box) { return; }
            if (box.style.display !== 'none') {
                box.style.display = 'none';
                return;
            }
            box.style.display = 'block';
            box.textContent = '正在读取日志…';
            request('GET', '/logs?lines=200', undefined, function (data) {
                var lines = (data && data.lines) || [];
                box.textContent = lines.length ? lines.join('\n') : '（日志为空）';
                box.scrollTop = box.scrollHeight;
            }, function (message) {
                box.textContent = '日志读取失败：' + message;
            });
        },

        save: function () {
            var me = this;
            if (me.saving) { return; }   // 三层监听可能同时触发，只放一次
            var box = me.node('content');
            var content = box ? box.value : '';
            if (!content || !content.replace(/\s/g, '')) {
                me.showToast('配置内容不能为空。', 'bad');
                return;
            }
            me.saving = true;
            var saveBtn = me.node('save');
            if (saveBtn) { saveBtn.disabled = true; }
            request('PUT', '/file', { content: content }, function (data) {
                me.saving = false;
                if (saveBtn) { saveBtn.disabled = false; }
                // 服务端会把内容整理后回写
                var box = me.node('content');
                if (data.state && typeof data.state.content === 'string' && box) {
                    me.desiredContent = data.state.content;
                    me.userEdited = false;
                    box.value = me.desiredContent;
                }
                if (data.started) {
                    me.showToast('已保存，frpc 已用新配置重启。', 'ok');
                } else {
                    me.showToast('已保存，但启动失败：' + (data.error || '请检查配置内容。'), 'bad');
                }
                me.showStatus(data.state && data.state.status);
            }, function (message) {
                me.saving = false;
                if (saveBtn) { saveBtn.disabled = false; }
                me.showToast('保存失败：' + message, 'bad');
            });
        },

        destroy: function () {
            if (this.pollId) {
                window.clearInterval(this.pollId);
                this.pollId = null;
            }
            if (this.toastTimer) { window.clearTimeout(this.toastTimer); this.toastTimer = null; }
            if (this.saveClickHandler) {
                document.removeEventListener('click', this.saveClickHandler);
                this.saveClickHandler = null;
            }
            if (window.__frpSave) { window.__frpSave = null; }
            if (window.__frpLog) { window.__frpLog = null; }
            SYNO.SDS.SynologyFrp.MainWindow.superclass.destroy.apply(this, arguments);
        }
    });
}());
