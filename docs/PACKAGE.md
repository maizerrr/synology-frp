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
- **窗口是 DSM 原生小浮动窗口**：`INFO` 的 `dsmappname` 用 `SYNO.SDS.SynologyFrp.Application`；`ui/config` 以 `SynologyFrp.js` 为键，登记三个类 —— `Application`（`type:"app"`，菜单入口）、`MainWindow`（`type:"lib"`，窗口本体）、`Utils`（工具方法）。`ui/SynologyFrp.js` 里 `Application` 继承 `SYNO.SDS.AppInstance`、`MainWindow` 继承 `SYNO.SDS.AppWindow`，并且**必须先把 `appInstance` 接过来再 callParent**。三者缺一，DSM 会建出任务栏标签但窗口为 null（表现为一直 loading、关不掉）。
- 窗口内是原生 ExtJS 控件：logo、一行说明、状态行、配置 TextArea、保存按钮。不用 iframe，也不塞大页面。
- `ui/index.html` 保留作排查页：浏览器直接打开 `/webman/3rdparty/synology-frp/index.html` 可验证"后端 + 反代"链路。
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
