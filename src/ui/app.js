/* FRP client - native DSM window.
 *
 * The window is built from DSM's own ExtJS widgets (no iframe): a toolbar with
 * the live status and run controls, the config editor, and the log pane.
 * Data comes from the package backend through the DSM same-origin proxy at
 * /webman/3rdparty/synology-frp/api/.
 *
 * Everything lives inside this closure: DSM shares one global scope between
 * packages.
 */
(function () {
    'use strict';

    var NAMESPACE = 'SYNO.SDS.SynologyFrp';
    var PACKAGE = 'synology-frp';
    var API = '/webman/3rdparty/' + PACKAGE + '/api';
    var POLL_MS = 3000;

    Ext.namespace(NAMESPACE);

    // ------------------------------------------------------------------ ajax
    function request(method, path, payload) {
        return new Promise(function (resolve, reject) {
            var options = {
                url: API + path,
                method: method,
                headers: { 'Accept': 'application/json' },
                callback: function (unused, success, response) {
                    var data = {};
                    try {
                        data = response.responseText ? Ext.decode(response.responseText) : {};
                    } catch (err) {
                        data = { message: '返回内容无法解析' };
                    }
                    if (success && response.status >= 200 && response.status < 300) {
                        resolve(data);
                        return;
                    }
                    var error = new Error(data.message || ('请求失败（' + response.status + '）'));
                    error.code = data.code;
                    error.status = response.status;
                    reject(error);
                }
            };
            if (payload !== undefined) {
                options.headers['Content-Type'] = 'application/json';
                options.rawData = Ext.encode(payload);
            }
            Ext.Ajax.request(options);
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

    function offlineHint(error) {
        return [
            '连不上套件的后台服务。',
            '',
            '1) 到「套件中心 → 已安装」确认本套件是「运行中」。',
            '2) SSH 执行 curl -s localhost:9844/api/health，有 JSON 回来说明后台正常。',
            '3) 后台正常但仍报错，说明 DSM 的反向代理没生效，把下面这段加到',
            '   /etc/nginx/conf.d/http.synology-frp.conf 后执行 nginx -t && nginx -s reload：',
            '',
            'location ^~ /webman/3rdparty/synology-frp/api/ {',
            '    proxy_pass http://127.0.0.1:9844/api/;',
            '    proxy_set_header Host $host;',
            '}',
            (error && error.message ? '\n技术细节：' + error.message : '')
        ].join('\n');
    }

    // ------------------------------------------------------------- components
    Ext.define(NAMESPACE + '.Instance', {
        extend: 'SYNO.SDS.AppInstance',
        appWindowName: NAMESPACE + '.MainWindow',
        constructor: function () {
            this.callParent(arguments);
        }
    });

    Ext.define(NAMESPACE + '.MainWindow', {
        extend: 'SYNO.SDS.AppWindow',

        constructor: function (config) {
            var me = this;

            me.ready = false;
            me.loadingFormat = false;

            me.statusField = Ext.create('Ext.toolbar.TextItem', {
                itemId: 'statusText',
                text: '正在读取状态…'
            });

            me.formatCombo = Ext.create('Ext.form.field.ComboBox', {
                itemId: 'formatCombo',
                editable: false,
                width: 150,
                store: [['toml', 'TOML'], ['ini', 'INI（旧格式）']],
                value: 'toml',
                listeners: {
                    change: function (combo, value) {
                        if (me.ready) { me.onFormatChange(value); }
                    }
                }
            });

            me.btnStart = Ext.create('Ext.button.Button', {
                text: '启动',
                handler: function () { me.runAction('start', '已启动'); }
            });
            me.btnStop = Ext.create('Ext.button.Button', {
                text: '停止',
                handler: function () { me.runAction('stop', '已停止'); }
            });
            me.btnRestart = Ext.create('Ext.button.Button', {
                text: '重启',
                handler: function () { me.runAction('restart', '已重启'); }
            });

            me.configArea = Ext.create('Ext.form.field.TextArea', {
                itemId: 'configArea',
                hideLabel: true,
                allowBlank: true,
                resizable: false,
                fieldStyle: 'height:100%;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;resize:none;'
            });

            me.logArea = Ext.create('Ext.form.field.TextArea', {
                itemId: 'logArea',
                hideLabel: true,
                readOnly: true,
                resizable: false,
                fieldStyle: 'height:100%;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;resize:none;background:#fafbfc;'
            });

            me.logPath = Ext.create('Ext.toolbar.TextItem', { itemId: 'logPath', text: '' });

            config = Ext.apply({
                width: 1000,
                height: 680,
                layout: 'border',
                border: false,
                dockedItems: [{
                    xtype: 'toolbar',
                    dock: 'top',
                    items: [
                        me.statusField,
                        '->',
                        me.formatCombo,
                        { xtype: 'tbseparator' },
                        me.btnStart,
                        me.btnStop,
                        me.btnRestart
                    ]
                }],
                items: [
                    {
                        xtype: 'panel',
                        region: 'center',
                        border: false,
                        layout: 'fit',
                        tbar: [
                            { xtype: 'tbtext', text: 'frpc 配置（保存后会自动重启）' },
                            '->',
                            {
                                xtype: 'button',
                                text: '保存并重启',
                                handler: function () { me.save(); }
                            }
                        ],
                        items: [me.configArea]
                    },
                    {
                        xtype: 'panel',
                        region: 'south',
                        height: 230,
                        split: true,
                        border: false,
                        layout: 'fit',
                        title: '最近日志',
                        collapsible: true,
                        collapseMode: 'mini',
                        tbar: [
                            { xtype: 'button', text: '刷新日志', handler: function () { me.loadLogs(); } },
                            '->',
                            me.logPath
                        ],
                        items: [me.logArea]
                    }
                ]
            }, config || {});

            me.callParent([config]);

            me.on('afterrender', function () { me.bootstrap(); });
            me.pollTimer = window.setInterval(function () { me.pollStatus(); }, POLL_MS);
        },

        // ------------------------------------------------------------ lifecycle
        bootstrap: function () {
            var me = this;
            me.loadState().then(function () {
                me.ready = true;
                me.loadLogs();
            }).catch(function (error) {
                me.statusField.setText('未连接后台服务');
                Ext.Msg.alert('连不上后台服务', offlineHint(error));
            });
        },

        loadState: function () {
            var me = this;
            return request('GET', '/state').then(function (data) {
                me.formatCombo.suspendEvents(false);
                me.formatCombo.setValue(data.format || 'toml');
                me.formatCombo.resumeEvents();
                if (me.configArea && !me.configArea.getValue()) {
                    me.configArea.setValue(data.content || '');
                }
                me.applyStatus(data.status || {});
                return data;
            });
        },

        pollStatus: function () {
            var me = this;
            if (me.destroyed) { return; }
            request('GET', '/state').then(function (data) {
                me.applyStatus(data.status || {});
            }).catch(function () {
                me.statusField.setText('未连接后台服务');
            });
        },

        applyStatus: function (status) {
            var me = this;
            if (!status.running) {
                me.statusField.setText('已停止');
                me.btnStart.enable();
                me.btnStop.disable();
                me.btnRestart.enable();
                return;
            }
            var text = '运行中';
            if (status.connected === false) {
                text += ' · 未连上服务器';
            } else if (status.connected === true) {
                text += ' · 已连上';
            }
            if (status.version) { text += ' · v' + status.version; }
            text += ' · 已运行 ' + duration(status.uptime);
            me.statusField.setText(text);
            me.btnStart.disable();
            me.btnStop.enable();
            me.btnRestart.enable();
        },

        // -------------------------------------------------------------- actions
        save: function () {
            var me = this;
            var content = me.configArea.getValue();
            var format = me.formatCombo.getValue() || 'toml';
            if (!content || !content.replace(/\s/g, '')) {
                Ext.Msg.alert('无法保存', '配置内容不能为空。');
                return;
            }
            request('PUT', '/file', { format: format, content: content }).then(function (data) {
                if (data.state && data.state.content) {
                    me.configArea.setValue(data.state.content);
                }
                if (data.started) {
                    Ext.Msg.alert('已保存并重启', '配置已生效。');
                } else {
                    Ext.Msg.alert('已保存，但启动失败', data.error || '请查看下方的日志。');
                }
                me.loadState();
                me.loadLogs();
            }).catch(function (error) {
                Ext.Msg.alert('保存失败', error.message);
            });
        },

        runAction: function (kind) {
            var me = this;
            request('POST', '/' + kind).then(function (data) {
                if (data.started === false) {
                    Ext.Msg.alert('启动失败', data.error || '');
                } else if (data.state) {
                    me.applyStatus(data.state.status || {});
                }
                me.loadLogs();
            }).catch(function (error) {
                Ext.Msg.alert('操作失败', error.message);
            });
        },

        loadLogs: function () {
            var me = this;
            request('GET', '/logs?lines=80').then(function (data) {
                me.logArea.setValue((data.lines || []).join('\n'));
                me.logPath.setText(data.path || '');
            }).catch(function () {
                me.logArea.setValue('（日志读取失败）');
            });
        },

        onFormatChange: function (value) {
            var me = this;
            if (!value || me.loadingFormat) { return; }
            me.loadingFormat = true;
            request('GET', '/template?format=' + encodeURIComponent(value)).then(function (data) {
                me.configArea.setValue(data.content || '');
                me.loadingFormat = false;
                Ext.Msg.alert('已载入 ' + value.toUpperCase() + ' 示例',
                    '确认内容后点「保存并重启」，旧格式的配置文件会被移除。');
            }).catch(function (error) {
                me.loadingFormat = false;
                Ext.Msg.alert('载入示例失败', error.message);
            });
        },

        // ------------------------------------------------------------- teardown
        destroy: function () {
            if (this.pollTimer) {
                window.clearInterval(this.pollTimer);
                this.pollTimer = null;
            }
            this.callParent(arguments);
        }
    });
}());
