/* DSM desktop window for the FRP client.
 *
 * Since DSM 7.2 a "type: url" application can only open a browser pop-up, so
 * the app is declared as a real ExtJS window (type: app + type: lib) and the
 * editor UI is hosted in an iframe inside that window. That keeps the DSM
 * title bar, task bar and single sign-on, and the page itself stays a plain
 * HTML app served from /webman/3rdparty/<package>/.
 *
 * Everything lives inside this closure: DSM shares one global scope between
 * packages.
 */
(function () {
    'use strict';

    var NAMESPACE = 'SYNO.SDS.SynologyFrp';
    var PACKAGE = 'synology-frp';

    Ext.namespace(NAMESPACE);

    Ext.apply(SYNO.SDS.SynologyFrp, {
        // Timestamp defeats DSM's caching of the iframe document.
        contentUrl: function () {
            return '/webman/3rdparty/' + PACKAGE + '/index.html?ts=' + new Date().getTime();
        }
    });

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
            config = Ext.apply({
                width: 1000,
                height: 660,
                layout: 'fit',
                items: [{
                    xtype: 'component',
                    autoEl: {
                        tag: 'iframe',
                        src: SYNO.SDS.SynologyFrp.contentUrl(),
                        frameborder: '0',
                        style: 'display:block;width:100%;height:100%;border:0;'
                    }
                }]
            }, config || {});
            this.callParent([config]);
        }
    });
}());
