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
                    me.editor
                ],
                buttons: [{
                    text: '保存',
                    width: 96,
                    handler: function () { me.save(); }
                }],
                buttonAlign: 'center'
            });

            config = Ext.apply({
                width: 760,
                height: 520,
                layout: 'fit',
                items: [content]
            }, config);

            SYNO.SDS.SynologyFrp.MainWindow.superclass.constructor.call(this, config);

            me.on('afterrender', function () { me.load(); });
            me.pollId = window.setInterval(function () { me.refreshStatus(); }, 5000);
        },

        load: function () {
            var me = this;
            request('GET', '/state', undefined, function (data) {
                if (data.content && !me.editor.getValue()) {
                    me.editor.setValue(data.content);
                }
                me.showStatus(data.status);
            }, function (message) {
                me.showStatusText('未连接后台服务：' + message);
            });
        },

        refreshStatus: function () {
            var me = this;
            if (me.destroyed) { return; }
            request('GET', '/state', undefined, function (data) {
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
            var content = me.editor.getValue();
            if (!content || !content.replace(/\s/g, '')) {
                Ext.Msg.alert('无法保存', '配置内容不能为空。');
                return;
            }
            request('PUT', '/file', { content: content }, function (data) {
                if (data.state && data.state.content) {
                    me.editor.setValue(data.state.content);
                }
                if (data.started) {
                    Ext.Msg.alert('已保存', '配置已保存，frpc 已用新配置重启。');
                } else {
                    Ext.Msg.alert('已保存，但启动失败', data.error || '请检查配置内容。');
                }
                me.showStatus(data.state && data.state.status);
            }, function (message) {
                Ext.Msg.alert('保存失败', message);
            });
        },

        destroy: function () {
            if (this.pollId) {
                window.clearInterval(this.pollId);
                this.pollId = null;
            }
            SYNO.SDS.SynologyFrp.MainWindow.superclass.destroy.apply(this, arguments);
        }
    });
}());
