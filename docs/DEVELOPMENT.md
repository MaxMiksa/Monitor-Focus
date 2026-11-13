# 开发与构建

## 工程与环境

单一 Go 工程：根目录 `*.go`、`go.mod`、`go.sum` 是 Wails 宿主；`internal/` 是原生适配与纯规则；`frontend/` 是 React/TypeScript 界面；`scripts/` 是构建、开发、部署与诊断入口；`calibrations/` 保存个人设备匹配数据；`build/` 只放可重建产物和诊断记录，不是源码。

```text
React/TypeScript → Wails 桥 → Go 宿主 / dispatcher
                              ├─ win32：DDC/CI、WMI、Gamma、前台会话、颜色恢复
                              ├─ audio：CoreAudio COM
                              ├─ desktop：滚轮钩子、遮罩、反馈、系统浮层
                              ├─ domain：设置、场景、计划、联动与补光规则
                              └─ startup：唯一 HKCU 登录自启项
```

正式构建把 `frontend/dist` 嵌入 exe，无生产 Node/Vite 或业务 HTTP 服务。运行只依赖 Windows x64 和 WebView2；开发依赖 Go 1.27.3、Wails 3.1.0、Node 24.11.1、pnpm 12.16.1。本机 SDK 为 `D:/Apps/go/bin/go.exe`，pnpm 为 `D:/Apps/pnpm/12.16.1/pnpm.exe`，前端锁是 `frontend/pnpm-lock.yaml`。

## 常用命令

```powershell
./scripts/build.ps1 -Check
./scripts/build.ps1 -Check -Package
./scripts/Dev.ps1
./scripts/Update-NativeGo.ps1 -Executable <包exe>
./scripts/Measure-NativeMemory.ps1 -Label <唯一标签>
```

- `scripts/build.ps1` 是唯一正式构建入口：冻结安装前端、构建内嵌资源、下载锁定 Go 依赖；`-Check` 追加前端 lint、Go test 与 vet，最终校验 PE 可写段后生成 `build/MonitorsFocus.Go.exe`。`-Package` 另外复制到 `build/packages/时间戳/MonitorsFocus.Go.exe`，时间戳由脚本生成，不在文档写死。构建不部署、不提交、不发布；若正在运行 `build/MonitorsFocus.Go.exe`，须先正常退出再构建；从 `build/packages/` 运行的独立包可继续使用。
- `scripts/Dev.ps1` 启动本地 Vite，并以独立 mock 模式打开 `build/MonitorsFocus.Go.exe`；不写硬件、不修改登录自启。启动前完成正式构建；浏览器预览带明确示例数据标识，不能把示例成功当作硬件成功。
- `scripts/Update-NativeGo.ps1 -Executable <包exe>` 读取当前快照，通过认证 IPC 正常退出旧核心，启动新包、等待硬件就绪并恢复目标／专注状态，核对唯一自启项；失败时先排空新核心再尝试独占回退。只传稳定的包路径，不覆盖运行中的 exe；更新结果写入 `build/diagnostics/`。
- `scripts/Measure-NativeMemory.ps1 -Label <唯一标签>` 对当前唯一 Go 核心做五轮面板开关，统计全部自有进程、Private Bytes、专用工作集、CPU 和可见窗口耗时，结果写入 `build/diagnostics/`。标签须唯一；可见窗口不等于渲染完成或可操作时间。
- `scripts/NativeControl.ps1` 提供 `Send-Go` 函数，连接当前用户、同会话、ACL 限定的本地命名管道，用于运维脚本；命令行 `--call`、诊断与硬件验收入口均不是前端开放动作。

正式 exe 无参数打开面板；`--background` 只启动托盘；唯一登录自启命令为 `MonitorsFocus.Go.exe --mode native --hardware --production --background`。`--production` 要求 `--mode native --hardware`，且不能与开发热加载共存。

## 运行链路与安全边界

- Wails 前端消息先校验 `http://wails.localhost` 的 Origin/TopOrigin 一致性与消息大小，生产页面通过 CSP 禁止所有 frame；`Backend.Request` 再按动作白名单分发。`dispatcher` 串行处理，仅合并同一控件相邻的同方向调节，快照、保存和其他设备是屏障。桥不提供通用 Shell、文件系统或任意命令执行。
- 本地命名管道只接受当前用户同一物理控制台会话的客户端；`host-memory` 分项诊断和显式 `host-memory-reclaim` 对照只从认证 IPC 进入，不在前端白名单。超时只让调用方继续，不取消仍在执行的硬件／COM 调用。
- 每个 `win32.Worker` 把 DDC 句柄和 COM 引用固定在一个 OS 线程上；`Close` 必须排空队列、等待在途调用结束再释放。同类约束适用于音频 MTA 线程和桌面消息线程。低级钩子回调只做有界的命中判断和入队，硬件、音量与绘制在回调外完成；关闭或退出先撤销钩子，再关闭桌面、音频和显示器。
- 所有亮度、Gamma 和颜色恢复写入前检查物理控制台会话、稳定 PnP 身份与设备映射；编号重新指向其他设备、身份未知或会话切换时拒绝。错误、部分应用和恢复失败分别进入快照警告或错误，不把失败伪装成成功。

## 硬件与颜色所有权

- 已识别外接屏通过 DDC/CI，内屏通过 WMI 写背光；每次变化写合法目标并读回。亮度只作用于实体屏幕，不向后台 RDP 会话发送控制。
- 逐屏 Gamma 以完整 `3×256` 原始表为基线，写入后读回验证；Kelvin 只是近似冷暖标尺，较暖端按 GDI 允许范围整体缩放。CCD 查询失败、复制目标、HDR、高级颜色或目标身份不一致时拒绝写入。
- 只有当前表仍等于本应用最后写入的表时才恢复；检测到未知外部颜色时保留其新值、停止调色并报告冲突。暖色目标约每 3 秒通过串行 worker 核对，仅退回保存的原色基线时重新应用。写入前把原色／最后写入表持久化到颜色 journal；失败保留 journal，重启只在旧属主已结束且身份仍匹配时恢复，不覆盖其他程序新颜色。
- 正常目标是用户亮度，背光目标可能含内屏暖色补光；两者在 `domain.ResolveBrightnessTargets` 中分开。补光仅用于已识别、非主屏、已校准、颜色由本应用持有的内屏；恢复原色、失败或退出前先撤回补光，再恢复颜色。
- 跨屏设备对曲线保存在 `calibrations/` 与用户配置中，按稳定 ID 匹配；缺少配对设备时绝不把曲线套到第三块屏或回退个人数据为默认。补光曲线与跨屏联动曲线独立。

## 配置、场景与启动

- 正式配置：`%LOCALAPPDATA%/Monitors-Focus-Go/native-settings.json`；颜色 journal 为同目录 `native-colors.json`；trace 为 `host-native.jsonl`，同一 Trace ID 贯穿界面接收、排队、硬件工作和回复。
- `domain.Store` 需要显式路径，读取不创建文件；坏文件、未知 schema、非普通文件和权限错误直接返回，不用默认值覆盖。保存比较 `Revision`，仅在成功时递增并返回新副本，使用同目录同步临时文件和原子替换，保留上一版 `.bak`；冲突保留调用方草稿，清理临时文件。锁文件残留须人工核对，不自动夺取。
- 显式迁移只继承已验证的旧版语言、专注延迟和自启偏好；先备份原始字节再首次写入，保留源文件。读取、迁移或核心初始化失败时，绝不按默认设置改动登录自启。
- 场景在 `Targets` 之外保存行为字段；旧场景只在内存补齐，不立即改写磁盘。计划按本地时钟求值，跨午夜连续；节点行为只应用一次，渐变期间不重复保存或重置专注。无关保存保留手动保持；行为已变化但持久化失败时不能接受返回状态为已提交。
- `startup` 只在配置成功加载／校验后由正式宿主显式调用，维护唯一 `HKCU MonitorsFocus` 项并清理历史别名；操作前快照、逐项读回、失败按相反顺序恢复，保留其他应用条目与已有启用字节。
- 正常退出保留最新正常亮度，卸载输入钩子与遮罩，撤回补光并恢复原色；非正式的原生硬件验收模式恢复到接管前现场；mock 只读写独立模拟配置，不接管硬件。不要让两个会写硬件的核心同时运行。

## 构建 overlay 与升级复核

Go 1.27.3 标准库 `crypto/internal/fips140/drbg` 的固定 32 MiB 可写静态熵源缓冲区会计入 Windows Private Bytes，即使未使用（上游 [issue 81956](https://github.com/golang/go/issues/81956)）。`scripts/New-GoMemoryOverlay.ps1` 生成本项目 `build/go-memory-overlay/`，用线程安全的首次使用分配替换该单一变量；随机算法、系统熵源与已安装 SDK 不变，不声称 FIPS 认证，也没有产品定时 GC 或工作集裁剪。

正式构建必须使用 `scripts/build.ps1` 应用 overlay，并在构建后校验 PE `.data` 可写段小于 8 MiB；直接 `go build` 不会获得该处理。Go 版本、标准库源结构或上游修复发生变化时，`New-GoMemoryOverlay.ps1` 会因精确匹配失败而停止构建；此时先复核是否应移除 overlay，再升级工具链，不能静默跳过。发布前用唯一标签实测内存，不能把历史数字当作新版结论。

## 前端与界面

- `frontend/src/index.css` 是唯一视觉参数入口；组件复用 shadcn 风格控件、Lucide 图标和 Motion 短反馈。重大界面改动先生成效果图并取得确认，再用与当前源码一致的真实截图核对。
- 前端通过 Wails runtime 发送请求并等待 `monitor-focus-reply`；示例数据只在明确 `?preview=1` 的浏览器预览中出现，硬件请求失败不回退成演示成功。
- 设置页共享草稿、撤销／重做和保存提示；状态推送不抢焦点或重置正在编辑的输入。错误、连接、检测、来源和保存结果常驻可见。

## 开发验收原则

优先保证功能，再做与风险相称的最小检查：`scripts/build.ps1 -Check` 覆盖冻结安装、前端 lint／构建、Go test／vet 与正式构建。涉及真实硬件时，先正常退出现用核心并确认颜色与亮度恢复，再独占运行显式验收入口；普通测试和浏览器预览不写真实显示器或音量。

诊断输出放 `build/diagnostics/`；清理 `build/` 前检查现用进程和登录自启，保留它们指向的包。前端使用项目级共享 pnpm store；改变目录层级后重新安装依赖链接，不清共享缓存。保留用户配置、个人校准和共享依赖缓存；清理一次性临时文件，不提交或发布。真实设备的目标状态、错误、Warning 和唯一自启项应在每次部署后重新核对。界面准则见[产品说明](PRODUCT.md)，本次验证状态与未测边界见[状态说明](STATUS.md)。
