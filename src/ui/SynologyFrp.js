/* FRP 客户端 —— DSM 原生小窗口。
 *
 * 依据 DSM 7.2+ 的实测配方（ExtJS）：
 *   INFO.dsmappname        = SYNO.SDS.SynologyFrp.Application
 *   ui/config              = 登记 Application(type:app) + MainWindow(type:lib) + Utils
 *   Application 继承 SYNO.SDS.AppInstance，appWindowName 指到 MainWindow
 *   MainWindow  继承 SYNO.SDS.AppWindow，必须先把 appInstance 接过来再 callParent
 * 缺任何一条，DSM 都会建出任务栏标签但窗口对象为 null（表现为一直 loading、关不掉）。
 */
(function () {
    'use strict';

    var NS = 'SYNO.SDS.SynologyFrp';
    var API = '/webman/3rdparty/synology-frp/api';

    // ------------------------------------------------------------------ utils
    Ext.namespace(NS + '.Utils');
    Ext.apply(SYNO.SDS.SynologyFrp.Utils, (function () {
        return {
            iconUrl: function () {
                return '/webman/3rdparty/synology-frp/images/icon_256.png?ts=' + new Date().getTime();
            },
            duration: function (seconds) {
                var value = Number(seconds) || 0;
                if (value < 60) { return value + ' 秒'; }
                var minutes = Math.floor(value / 60);
                if (minutes < 60) { return minutes + ' 分钟'; }
                var hours = Math.floor(minutes / 60);
                if (hours < 24) { return hours + ' 小时'; }
                return Math.floor(hours / 24) + ' 天';
            },
            statusText: function (status) {
                if (!status || !status.running) { return '当前状态：已停止'; }
                var text = '当前状态：运行中';
                if (status.connected === false) {
                    text += '（未连上服务器）';
                } else if (status.connected === true) {
                    text += '（已连上）';
                }
                if (status.version) { text += ' · v' + status.version; }
                text += ' · 已运行 ' + SYNO.SDS.SynologyFrp.Utils.duration(status.uptime);
                return text;
            }
        };
    }()));

    // --------------------------------------------------------------- io calls
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
                if (onFail) { onFail(data.message || ('请求失败（' + response.status + '）'), response.status); }
            }
        };
        if (payload !== undefined) {
            options.headers['Content-Type'] = 'application/json';
            options.rawData = Ext.encode(payload);
        }
        Ext.Ajax.request(options);
    }

    // ------------------------------------------------------------- application
    Ext.define(NS + '.Application', {
        extend: 'SYNO.SDS.AppInstance',
        appWindowName: NS + '.MainWindow',
        constructor: function () {
            this.callParent(arguments);
        }
    });

    Ext.define(NS + '.MainWindow', {
        extend: 'SYNO.SDS.AppWindow',

        constructor: function (cfg) {
            var me = this;
            // DSM may instantiate the window without a config object: guard before
            // touching cfg, otherwise the constructor throws and no window appears.
            cfg = cfg || {};
            me.appInstance = cfg.appInstance || me.appInstance;

            me.editor = Ext.create('Ext.form.field.TextArea', {
                itemId: 'content',
                hideLabel: true,
                flex: 1,
                resizable: false,
                fieldStyle: 'font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;resize:none;'
            });

            me.statusLine = Ext.create('Ext.Component', {
                itemId: 'statusLine',
                margin: '0 0 8 0',
                html: '<div style="color:#8a929c;font-size:12px">正在读取状态…</div>'
            });

            cfg = Ext.apply({
                width: 760,
                height: 500,
                layout: 'fit',
                items: [{
                    xtype: 'panel',
                    border: false,
                    bodyPadding: '16 18 16 18',
                    layout: { type: 'vbox', align: 'stretch' },
                    items: [
                        {
                            xtype: 'component',
                            html: '<div style="text-align:center"><img src="' +
                                SYNO.SDS.SynologyFrp.Utils.iconUrl() +
                                '" style="width:88px;height:88px;border-radius:50%;" alt=""></div>'
                        },
                        {
                            xtype: 'component',
                            margin: '10 0 6 0',
                            html: '<div style="text-align:center;color:#5c6672;font-size:13px">' +
                                '套件全局参数配置，保存后会自动重启套件生效！！！</div>'
                        },
                        me.statusLine,
                        me.editor,
                        {
                            xtype: 'container',
                            margin: '12 0 0 0',
                            layout: { type: 'hbox', pack: 'center' },
                            items: [{
                                xtype: 'button',
                                text: '保存',
                                width: 96,
                                handler: function () { me.save(); }
                            }]
                        }
                    ]
                }]
            }, cfg || {});

            me.callParent([cfg]);

            me.on('afterrender', function () { me.load(); });
            me.pollTimer = window.setInterval(function () { me.refreshStatus(); }, 4000);
        },

        load: function () {
            var me = this;
            request('GET', '/state', undefined, function (data) {
                if (data.content && !me.editor.getValue()) {
                    me.editor.setValue(data.content);
                }
                me.showStatus(data.status);
            }, function (message) {
                me.setStatusHtml('未连接后台服务：' + message, '#d93025');
            });
        },

        refreshStatus: function () {
            var me = this;
            if (me.destroyed) { return; }
            request('GET', '/state', undefined, function (data) {
                me.showStatus(data.status);
            }, function () {
                me.setStatusHtml('未连接后台服务', '#d93025');
            });
        },

        showStatus: function (status) {
            var running = status && status.running;
            this.setStatusHtml(SYNO.SDS.SynologyFrp.Utils.statusText(status), running ? '#8a929c' : '#8a929c');
        },

        setStatusHtml: function (text, color) {
            var node = this.down('#statusLine');
            if (node) {
                node.update('<div style="color:' + (color || '#8a929c') + ';font-size:12px">' +
                    Ext.util.Format.htmlEncode(text) + '</div>');
            }
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
            if (this.pollTimer) {
                window.clearInterval(this.pollTimer);
                this.pollTimer = null;
            }
            this.callParent(arguments);
        }
    });
}());
