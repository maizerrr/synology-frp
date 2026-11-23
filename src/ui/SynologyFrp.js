/* FRP 客户端 —— DSM 原生窗口。
 *
 * 事实（在 DSM 7.4 上实测得来）：
 *   - DSM 桌面加载的是 Ext JS 3.4.0（/scripts/ext-3/ext-all.js），不是 Ext 4。
 *   - 所以必须用 Ext.extend + superclass.constructor.call；
 *     Ext.define / this.callParent 会拿到 null 的父类
 *     （报 "TypeError: Cannot read properties of null (reading 'apply')"）。
 *   - 组件类名是 Ext.form.TextArea；Ext.create 也不要用。
 * 窗口创建失败时 DSM 会留下一个永远 loading 的任务栏标签，因此这里不吞异常。
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
    // Ext 3 的按钮在 DSM 主题下会退化成纯文字，所以保存用真实的 <button>，
    // 样式对齐 DSM 主按钮（蓝色实心、4px 圆角、30px 高）。
    var CSS = [
        '.frp-footer{text-align:center;padding:12px 0 2px}',
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
        // "parameter 1 is not of type 'Node'"。DomHelper 是 Ext 自己的实现。
        var head = document.getElementsByTagName('head')[0] || document.body;
        Ext.DomHelper.append(head, {
            tag: 'style',
            id: 'frp-window-style',
            html: CSS
        });
    }

    function iconUrl() {
        return ASSET + 'images/icon_256.png?ts=' + new Date().getTime();
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

            me.statusEl = new Ext.BoxComponent({
                autoEl: {
                    tag: 'div',
                    html: '<div style="color:#8a929c;font-size:12px;padding:0 0 8px">正在读取状态…</div>'
                }
            });

            me.editor = new Ext.form.TextArea({
                hideLabel: true,
                flex: 1,
                style: 'font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;'
            });

            var content = new Ext.form.FormPanel({
                border: false,
                bodyStyle: 'padding:16px 18px;background:#fff',
                layout: 'vbox',
                layoutConfig: { align: 'stretch' },
                items: [
                    new Ext.BoxComponent({
                        autoEl: {
                            tag: 'div',
                            html: '<div style="text-align:center;padding:2px 0 10px">' +
                                '<img src="' + iconUrl() + '" width="88" height="88" ' +
                                'style="border-radius:44px" alt=""></div>'
                        }
                    }),
                    new Ext.BoxComponent({
                        autoEl: {
                            tag: 'div',
                            html: '<div style="text-align:center;color:#5c6672;font-size:13px;' +
                                'padding:0 0 10px">套件全局参数配置，保存后会自动重启套件生效！！！</div>'
                        }
                    }),
                    me.statusEl,
                    me.editor,
                    // 注意：不要挂到 this.footer —— Ext 3 的 Panel 内部就用
                    // 这个属性名，撞车会让渲染时 appendChild(undefined)。
                    new Ext.BoxComponent({
                        autoEl: {
                            tag: 'div',
                            html: '<div class="frp-footer">' +
                                '<button type="button" class="frp-btn" data-el="save" ' +
                                'onclick="window.__frpSave&&window.__frpSave();return false;">保存并重启</button>' +
                                '</div>'
                        },
                        listeners: {
                            // 第三层保险：按钮自己身上的监听。DSM 的窗口管理器
                            // 可能会吞掉冒泡到 document 的事件，这一层不受影响。
                            afterrender: function (cmp) {
                                var btn = cmp.getEl() && cmp.getEl().dom.querySelector('[data-el="save"]');
                                if (btn) {
                                    btn.addEventListener('click', function (event) {
                                        event.preventDefault();
                                        me.save();
                                    });
                                }
                            }
                        }
                    })
                ]
            });

            config = Ext.apply({
                width: 760,
                height: 520,
                layout: 'fit',
                items: [content]
            }, config);

            SYNO.SDS.SynologyFrp.MainWindow.superclass.constructor.call(this, config);

            me.on('afterrender', function () {
                // 用户一旦在框里敲过字，就再也不自动回填
                var el = me.editor.getEl();
                if (el && el.dom && el.dom.addEventListener) {
                    el.dom.addEventListener('input', function () { me.userEdited = true; });
                }
                me.load();
            });

            // 保存按钮：DSM 的 AppWindow 里 getEl() 拿不到按钮所在的容器
            // （querySelector 返回 null，点击等于没绑），所以在 document 上做
            // 事件委托，与 DOM 层级无关。
            me.saveClickHandler = function (event) {
                var node = event.target;
                if (node && node.getAttribute && node.getAttribute('data-el') === 'save') {
                    event.preventDefault();
                    me.save();
                }
            };
            document.addEventListener('click', me.saveClickHandler);
            // 内联 onclick 走这个桥；不依赖 DOM 层级，也不怕事件冒泡被拦
            window.__frpSave = function () { me.save(); };
            me.pollId = window.setInterval(function () { me.refreshStatus(); }, 5000);
        },

        load: function () {
            var me = this;
            request('GET', '/state', undefined, function (data) {
                me.applyContent(data);
                me.showStatus(data.status);
                // DSM 会在窗口首次 show 之后重置表单字段，补两次；applyContent
                // 只有在内容仍未落到 DOM 时才会动手，所以不会盖掉用户的编辑。
                Ext.defer(function () { me.applyContent(data); }, 400);
                Ext.defer(function () { me.applyContent(data); }, 1500);
            }, function (message) {
                me.showStatusText('未连接后台服务：' + message);
            });
        },

        // 服务端内容按需回填：DSM 会在窗口首次 show 之后把表单字段清空，
        // 所以不能「填一次就完事」。一旦用户自己动过内容，就再也不回填。
        // 直接写 DOM：Ext 3 的 setValue 会走 validate 链，字段被重置后
        // errorMsgEl 是 undefined，会抛 "Cannot read properties of undefined"。
        applyContent: function (data) {
            var me = this;
            if (data && typeof data.content === 'string' && data.content) {
                me.desiredContent = data.content;
            }
            if (me.userEdited || !me.desiredContent) { return; }
            var el = me.editor.getEl();
            if (!el || !el.dom) { return; }
            if (el.dom.value === me.desiredContent) { return; }
            if (el.dom.value !== '') { return; }
            el.dom.value = me.desiredContent;
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
            var el = this.statusEl && this.statusEl.getEl();
            if (!el) { return; }
            el.dom.innerHTML = '<div style="color:#8a929c;font-size:12px;padding:0 0 8px">' +
                Ext.util.Format.htmlEncode(text) + '</div>';
        },

        save: function () {
            var me = this;
            if (me.saving) { return; }   // 三层监听可能同时触发，只放一次
            var inputEl = me.editor.getEl();
            var content = (inputEl && inputEl.dom) ? inputEl.dom.value : me.editor.getValue();
            if (!content || !content.replace(/\s/g, '')) {
                Ext.Msg.alert('无法保存', '配置内容不能为空。');
                return;
            }
            me.saving = true;
            request('PUT', '/file', { content: content }, function (data) {
                me.saving = false;
                // 服务端会把内容整理后回写，直接改 DOM（setValue 会走校验链）
                if (data.state && typeof data.state.content === 'string') {
                    me.desiredContent = data.state.content;
                    var el = me.editor.getEl();
                    if (el && el.dom) { el.dom.value = me.desiredContent; }
                }
                if (data.started) {
                    Ext.Msg.alert('已保存', '配置已保存，frpc 已用新配置重启。');
                } else {
                    Ext.Msg.alert('已保存，但启动失败', data.error || '请检查配置内容。');
                }
                me.showStatus(data.state && data.state.status);
            }, function (message) {
                me.saving = false;
                Ext.Msg.alert('保存失败', message);
            });
        },

        destroy: function () {
            if (this.pollId) {
                window.clearInterval(this.pollId);
                this.pollId = null;
            }
            if (this.saveClickHandler) {
                document.removeEventListener('click', this.saveClickHandler);
                this.saveClickHandler = null;
            }
            if (window.__frpSave) { window.__frpSave = null; }
            SYNO.SDS.SynologyFrp.MainWindow.superclass.destroy.apply(this, arguments);
        }
    });
}());
