# 群晖套件层（synology-frp）

这个仓库是 frp 的源码分支，本文件说明**套件部分**怎么构建、测试和安装。
frp 自身的构建方式见上游 `Makefile` / `README.md`，这里不做改动。

## 目录

```
INFO                      套件元数据（x86_64 平台组）
PACKAGE_ICON*.PNG         包中心图标（由 tools/make_icon.py 生成）
build.sh                  组装 dist/*.spk
engine/Dockerfile         从本仓库源码编译静态 frpc
engine/build.sh           产出 vendor/frpc/frpc
package/conf/             privilege + DSM nginx 反代模板
package/scripts/          生命周期脚本
src/backend/              零依赖 Python3 服务（配置读写 + frpc 进程托管）
src/frontend/             单页 UI，打包成 ui/
src/ui/config             DSM 桌面应用定义
tests/                    pytest（42 条）
docs/ACCEPTANCE.md        黑盒验收标准
```

## 构建

```bash
./engine/build.sh     # 用 Docker 编译 frpc（产出 vendor/frpc/frpc，约 16 MB）
./tools/bump.sh       # 改完代码先升版本号（默认 patch+1），否则群晖会复用老包缓存
./build.sh            # 组装 dist/synology-frp-<version>.spk
python3 -m pytest -q --basetemp=./.pytest-tmp
```

前置：Docker（编译 frpc 用）、Python 3.9+（跑后端与测试）。

## 几个刻意的决定

- **CGO_ENABLED=0**：产出的 frpc 不依赖任何 libc，所以不用像内嵌 transmission 那样带 musl 加载器，任何 DSM 版本都能直接跑。
- **`web/frpc/dist` 占位**：`web/frpc/embed.go` 里有 `//go:embed dist`，而 dist 是 npm 构建产物、仓库里没有。我们不发布 frpc 自带的 dashboard，所以构建时放一个占位 `index.html` 让 embed 能解析。
- **默认模板含 `loginFailExit = false`**：实测 frp 0.72 默认「首次登录失败就退出」，在 NAS 上等于服务器抖一下隧道就永久断了。设为 false 后它会一直重试。
- **UI 与 frpc 分开守护**：`start-stop-status` 只管 UI 进程；frpc 由 UI 托管，所以配置写坏时 UI 还活着、能告诉你错在哪（卸载/停止时两进程一起收）。
- **窗口是 DSM 原生小浮动窗口**：`INFO` 的 `dsmappname` 用 `SYNO.SDS.SynologyFrp.Application`；`ui/config` 以 `SynologyFrp.js` 为键，登记 `Application`（`type:"app"`，菜单入口）与 `MainWindow`（`type:"lib"`，窗口本体）。
- **必须用 Ext JS 3 的写法**：DSM 桌面加载的是 Ext JS **3.4**（`/scripts/ext-3/ext-all.js`），`Ext.define` / `this.callParent` 是 Ext 4 的 API，在 3.4 上父类解析为 null，构造直接抛 `Cannot read properties of null (reading 'apply')`。所以类用 `Ext.extend(基类, {...})` 定义、构造里用 `superclass.constructor.call(this, ...)`；组件类名是 `Ext.form.TextArea` 而不是 `Ext.form.field.TextArea`；`Ext.create` 也不能用。窗口创建失败时 DSM 会留下一个永远 loading、关不掉的任务栏标签，症状具有误导性。
- **配置回填要防「字段被重置」**：DSM 在窗口首次 show 之后会把表单字段清空，而 Ext 3 的 `setValue` 会走校验链（`errorMsgEl` 此时是 undefined），直接抛错、内容永远填不进去。正确做法是直接写 `el.dom.value`，并在首次加载后补两次（400ms / 1500ms），轮询里也继续补；一旦用户按过键（`input` 事件）就不再回填，避免盖掉正在编辑的内容。
- **窗口内是纯 DOM，不用 Ext 控件**：Ext 3 的按钮在 DSM 主题下退化成纯文字、`Ext.Msg` 只剩一个灰块（按钮完全看不见）、vbox 布局用绝对定位算高度（多一个元素就错位，按钮会跑到顶部）。所以窗口 body 只有一段 HTML + flex 布局，Ext 只提供窗口外壳；提示信息用窗口内的内联条，不弹窗。
- **保存慢的根因是僵尸进程**：`stop()` 以前用 `kill(pid, 0)` 判断是否退出，但子进程退出后没被 `wait()` 回收，`kill(pid, 0)` 依然成功 → 每次保存都要空转满 2 秒；再加上启动后固定 `sleep(0.9)`，一共约 3 秒。现在保留 Popen 句柄、`wait()` 回收，启动探测改成 50ms 轮询最多 0.6 秒，保存降到 1 秒内。
- **API 走 DSM 自己的 nginx，但要按 DSM 7.2 的 `web-config` 声明**：光放一个 `conf/nginx/nginx.conf.template` DSM **不会**接管（实测在任何端口都不生效，请求落到 DSM 自己的 403 页）。正确做法是在 `conf/resource` 里登记
  `{"web-config": {"nginx-static-config": {"enable": [{"type": "dsm", "relpath": "nginx/api.conf"}]}}}`，
  并把片段打进 `package.tgz` 的 `nginx/api.conf`（`relpath` 相对包 target 目录），`INFO` 里写 `instuninst_restart_services="nginx.service"`，DSM 才会把它链进 DSM server block 并 reload。`type` 可选 `dsm/www/http/server/x-accel/main`，`dsm` 表示放进 DSM 自己的 server block（含自定义端口/域名块）。
- **端口 9844 仅监听 127.0.0.1**，浏览器侧走 DSM 同源反代，登录态由 DSM 兜住，套件内不自建账号。
- **配置文件在套件私有目录**（`/var/packages/synology-frp/var/frpc.toml|.ini`），卸载默认保留，重装自动接回。

## 安装（真机）

1. 套件中心 → 手动安装 → 选 `dist/synology-frp-<version>.spk`
2. 主菜单「FRP 客户端」→ 打开 → 顶部状态显示「运行中 / 未连上服务器」
3. 编辑器里把 `serverAddr` / `serverPort` 改成你的 frps，按需改 `[[proxies]]`
4. 点「保存并重启」→ 状态变「已连上」，日志里出现 `login to server success`
5. 配置写错时：会显示「已保存，但启动失败」并附上 frpc 的原始报错

排查：
- UI 服务日志 `/var/packages/synology-frp/var/logs/service.log`
- frpc 输出 `/var/packages/synology-frp/var/logs/frpc.log`（页面里也能看最近 80 行）
