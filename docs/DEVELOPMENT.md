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
- 场景在 `Targets` 之外保存行为字段；旧场景只在内存补齐，不立即改写磁盘。可选 `ScheduleTransitionMinutes` 仅保存统一时长偏好（包括空计划），编辑时同步各节点，旧配置不迁移覆盖；计划仍按节点时长和本地时钟求值，跨午夜连续；节点行为只应用一次，渐变期间不重复保存或重置专注。无关保存保留手动保持；行为已变化但持久化失败时不能接受返回状态为已提交。
- `startup` 只在配置成功加载／校验后由正式宿主显式调用，维护唯一 `HKCU MonitorsFocus` 项并清理历史别名；操作前快照、逐项读回、失败按相反顺序恢复，保留其他应用条目与已有启用字节。
- 正常退出保留最新正常亮度，卸载输入钩子与遮罩，撤回补光并恢复原色；非正式的原生硬件验收模式恢复到接管前现场；mock 只读写独立模拟配置，不接管硬件。不要让两个会写硬件的核心同时运行。

## 构建 overlay 与升级复核

Go 1.27.3 标准库 `crypto/internal/fips140/drbg` 的固定 32 MiB 可写静态熵源缓冲区会计入 Windows Private Bytes，即使未使用（上游 [issue 81956](https://github.com/golang/go/issues/81956)）。`scripts/New-GoMemoryOverlay.ps1` 生成本项目 `build/go-memory-overlay/`，用线程安全的首次使用分配替换该单一变量；随机算法、系统熵源与已安装 SDK 不变，不声称 FIPS 认证，也没有产品定时 GC 或工作集裁剪。

正式构建必须使用 `scripts/build.ps1` 应用 overlay，并在构建后校验 PE `.data` 可写段小于 8 MiB；直接 `go build` 不会获得该处理。Go 版本、标准库源结构或上游修复发生变化时，`New-GoMemoryOverlay.ps1` 会因精确匹配失败而停止构建；此时先复核是否应移除 overlay，再升级工具链，不能静默跳过。发布前用唯一标签实测内存，不能把历史数字当作新版结论。

## 前端与界面

- 场景权重由 `scripts/export-scene-region-mask.py` 从对齐的中午原图按实际轮廓离线生成：天空 204、草地 166、机器 141；输出开发母版 `frontend/public/scene-morph-mask-v7.png` 和无损运行图 `frontend/public/scenes/live/mask.webp`。天空不再保留飞絮／星点白斑、横向灰带或扩大保护。天空组件用 `scripts/export-sky-mask.py` 从该权重图派生 9 KiB 的 RGBA 天空遮罩 `sky-mask.png`，CSS cover 与底图对齐，云彩／星星不覆盖草地和机器。遮罩按真实轮廓裁切，无近似地平线或扩大保护。

- `frontend/src/index.css` 是唯一视觉参数入口；全局字号为正文／按钮 16px、小标题 18px、页面标题 26px，胶囊文字行高 1.25，固定面板不随字号或视口改变尺寸；组件复用 shadcn 风格控件、Lucide 图标和 Motion 短反馈。重大界面改动先生成效果图并取得确认，再用与当前源码一致的真实截图核对。
- 快捷面板与设置页共用 1168 × 657 DIP（较上一版宽高再增约 10%；最小宽 1024 DIP） 的 16:9 客户区；`window_ratio_windows.go` 用 `WM_SIZING` 和窗口尺寸事件锁定比例，`main.go` 在首次显示及系统贴靠／最大化后恢复并居中。`resizePanel` 仅保留兼容动作，不再切换窗口尺寸。
- `frontend/public/scenes/` 保存当前版早 / 中 / 傍晚 / 夜四张无文字、无组件的整页 16:9 原创 WebP；`frontend/public/scenes/live/` 保存新版同机位四张 WebP 和一张灰度权重 WebP。仅供开发使用的四张高清 PNG、v7 权重图和 `scene-motion-prototype.html` 留在 `frontend/public/`，Vite 构建结束阶段由 `excludeDevelopmentAssets` 插件从 `frontend/dist` 删除，不进入 exe。正式构建只嵌入场景资源；运行时不请求远程图片或视频，不引入视频解码依赖。真实控件由 React 绘制，避免图片中的按钮与可操作热区错位。
- 新版舞台的 `LiveSceneStage` 默认启用，「设置 → 通用 → 主界面样式」可切回当前版；偏好存于 `localStorage` 并由 `storage` 事件同步，不进入 Go `Settings`、不改 Revision 或配置迁移。底图常态仅一张全尺寸画面、一张权重图和一张 640×320 飞絮天空补片图集；切换时临时多一张目标画面，完成后直接交换并释放旧纹理。再次选场景时，GPU 将当前已显示的基础画面合成为一次性衔接纹理，再直接转向新目标；中断时最多三张场景纹理，完成后恢复一张，不保留历史快照。隐藏、减少动态效果时停止循环；WebGL 初始化失败释放上下文并按当前场景显示原始静态图。
- `SkyEffects` 按当前场景的有效开关创建资源：星星按样式与数量实际分配（上限 18,000），关闭／数量为零／亮度为零即释放；仅创建当前选用的 pmndrs 组件云或旧版薄云，关闭／浓度为零／切换类型时释放旧资源。两类效果均停用时卸载天空画布并释放上下文，恢复时按需重建；延迟图片回调不能复活已释放云彩。保留 `@pmndrs/vanilla` 1.25.0、Three.js 0.187.0、72 云片上限、原纹理／样式／独立闪烁与场景偏好；最高 20 fps，隐藏暂停，减少动态效果启动时绘静态帧。偏好仍复用 `sky-preference.ts` 与自动保存／撤销，天空编辑只预览，不发送硬件场景请求。背景舞台保持独立。

天空按需资源验收：`build/diagnostics/sky-demand-verification.json` 记录 11 项真实浏览器资源检查：稀疏星星仅分配 540 点、密集替换不积累、四种云样式按需切换、零亮度／浓度卸载、反复开关与延迟图片回调安全、场景导航恢复；停用后缓冲／程序释放，天空上下文销毁。减少动态效果仅验证启动时静态绘制，运行中改变系统偏好未验收。正式构建／lint、Go test／vet 和 PE 检查通过，日志为 `sky-demand-build.log`。同场景五次开关各取 15 个样本，中位独占物理内存打开时约 194.32→179.40 MiB，私有提交量 474.45→459.14 MiB；关闭后的 15 个样本均无 WebView2。旧核心长期运行、新核心刚重启，后台独占也从 20.19 降到 13.41 MiB，因此不能把全部降幅归因于天空优化；此为面板打开短测，不等于设置页展开或长期／显存结论。对照见 `sky-demand-memory-comparison.json` 与 before／after 原始记录。

- 飞絮由 `scripts/export-seed-patches.py` 离线制作局部补片，输出 `frontend/public/scenes/live/seed-sky-patches.png` 与 `frontend/src/lib/seed-patches.json`。不改原始 WebP；同一片元程序先补原位置，再从原图减去补片，搬移有符号细节，避免蓝色矩形边缘。10 个偏移量每次绘制计算一次，复用 80 字节数组，不逐像素算轨迹；独立 120 秒无缝时钟，不随场景切换重置。图集 RGB 上传数据 600 KiB，驱动实际内存另测；生成过程只依赖开发机 Python／Pillow／NumPy／OpenCV，产品不依赖它们。
- 快捷面板的四颗按钮按场景名称显式映射早 / 中 / 傍晚 / 夜，不按目标小时就近取场景；无法识别的名称才按亮度兜底。浏览器示例数据与每日计划同步使用四个场景和四个节点。亮度滑条左端月亮、右端太阳，表示从暗到亮；更多控制只列出未映射到四颗按钮的场景。
- 前端通过 Wails runtime 发送请求并等待 `monitor-focus-reply`；示例数据只在明确 `?preview=1` 的浏览器预览中出现，硬件请求失败不回退成演示成功。
- `@fontsource-variable/noto-sans` 与 `noto-sans-sc` 提供离线可变字体，通过 index.css 的 @import 与全局 --font-sans 应用于文字、表单及图表。Unicode 分片 WOFF2 随 Vite 构建嵌入，只加载所需字形片；不请求远程字体。OFL 完整许可合入项目及分发 notices。
- 品牌图形源为 `frontend/public/favicon.svg`（Lucide Sun–Moon，许可见 `THIRD_PARTY_NOTICES.md`，分发副本嵌入 `frontend/public/third-party-notices.txt`）。更改 SVG 后运行 `D:/Apps/python/python.exe scripts/export-icons.py`，用本机 CairoSVG/Pillow 派生透明底黑／白 ICO；普通构建无需 Python。`scripts/Set-ExecutableIcon.ps1` 在打包前写入 exe 的两组图标资源；`window_icon_windows.go` 按系统深浅色设置窗口大小图标和托盘图标。Windows 的 Wails `App.SetIcon` 实现为空，不能用它代替资源和 `WM_SETICON`。
- `settings-editor.tsx` 是始终挂载的首页玻璃浮层，五个底部分类（当下默认）共享 `lib/settings-history.ts` 的草稿和历史。500 ms 防抖、串行保存、Revision 校验；稳定排序的内容指纹避免 Go/JS 字段顺序引起重复保存。保存期间的新改动继续排队，失败保留草稿；撤销／重做（含本地外观偏好）同样保存。Esc 关闭和首页场景请求先 flush，失败重新展开浮层。状态推送不抢焦点或覆盖未保存内容。
- 窗口为 frameless，无顶部窗口栏；保留顶部 28px 隐形拖动区。设置浮层由胶囊向上裁切展开，无向下箭头，顶部不留操作行；重新检测与「已自动保存」及变化图标位于底栏左侧，浮层固定 958×526 DIP，左右与上下始终居中，不随主窗口缩放；内部布局不依赖视口断点，五导航与收起胶囊共用垂直中心锚点（距浮层底边约 32px），不以各自底边对齐；首页场景栏及按钮均按内容定宽，取消百分比宽度、最小固定宽度与 flex 等分；外框内边距和按钮间距由 --nav-focus-size 按比例派生，内部 scene-capsule-focus 按内容包裹；它与设置页选中按钮共用玻璃材质，高 38px、文字左右 15px 留白，纯图标 38px 正圆；图标 19px／2.1px 描边及 96% 白色、内外框增强边缘对比，外框上下高光强度一致、选中圈不加单侧高光，阴影垂直偏移为零，避免光影破坏等距观感，无背景模糊；历史组右／下等距 14px。专注／通用以独立分组固定归属，场景两列网格纵向延伸、四项同屏。舞台 overflow: clip 防止焦点自动滚动破坏居中。首页方向键／WASD 切场景与展开；浮层内切分类，↓ / S 收起；Esc 收起后再按通过既有 `window-close` 销毁面板并保留托盘核心。输入控件、组合输入和已处理的按键不被全局导航劫持。

联合版验收：`build/diagnostics/sky-weather-unified-20261115.json` 记录五次开关面板；15 个关闭后采样均为 0 个 WebView2，最后关闭的 Private Bytes／专用工作集约 35.30／18.67 MB。仅证明本次开关释放路径，不证明长期无泄漏或已测显存。部署与唯一自启证据见同前缀 `-update.json`，前端／正式构建日志、样式截图和隔离源码清单见 `build/diagnostics/sky-effects/`。

## 开发验收原则

雨效选型预览位于 `scripts/rain-preview/`，`npm ci --ignore-scripts` 后 `npm start`，仅在 `127.0.0.1:5194` 提供浏览器页面；不进入正式前端或 exe，不接硬件／天气。锁定 tsParticles 4.5.3 与 three.quarks 0.17.1，六种配置共用同一场景、0–100 雨量、30 fps 上限、原景对照／暂停／纯净观景；只运行当前候选，切换销毁画布与计时器，隐藏暂停。选择仅写预览独立偏好，最终接入与原生内存对比待用户选定后开展。已验证组件切换只有一个画布且无控制台错误。第六款 local-cloud.js 使用透明乌云（运行时缩至 512px）、源图坐标定位的局部画布与三个复用 quarks 系统，雨滴碰撞机顶后停止并发射水珠／水冠；粒子上限分别为 96／128／32，DPR 1、30 fps，不创建逐次碰撞系统。零雨量清空隐藏乌云，暂停停止推进，四背景与纯净观景沿用同一机顶坐标；已验证零雨量、暂停／恢复、原景对照、四背景及切换，截图位于 build/diagnostics/rain-gallery/cloud-preview.jpg。这不等于已测正式版总内存。

天气雨景：`frontend/src/lib/weather.ts` 只在面板实时舞台中请求固定 HTTPS `api.open-meteo.com`／`geocoding-api.open-meteo.com`，生产 CSP 仅增加这两个连接来源；不经过硬件串行队列、不增加 Go 后台轮询。请求 10 秒超时、64 KiB 响应上限、禁凭据／跳转，校验城市坐标、当前天气字段／代码／时间；15 分钟刷新，30 分钟到期停止沿用缓存，隐藏取消请求，卸载取消定时器及请求。`weather-settings.tsx` 负责搜索／选择和临时预览，偏好纳入 `settings-history.ts`。雨丝直接并入 `LiveSceneStage` 原片元程序，复用现有纹理／画布／时钟，雨天最高 24 fps（场景切换仍最多 30 fps），减少动态效果时仅静态绘制。未引入视频、雨景图集或额外依赖；生成效果图仅用于设计确认，不进入发布资源。

雨景验收证据：`build/diagnostics/weather-state-checks.json` 覆盖雨／无雨、错误天气代码、15 分钟刷新、30 分钟缓存过期、隐藏暂停及卸载清理；`weather-rain-memory.json` 是相同正式 exe 在原生 WebView2、mock 硬件隔离下所有自有进程的短时对照。热态关闭／开启雨丝的 Private Bytes 中位数约 418.95／413.59 MB，专用工作集约 185.71／186.08 MB；这说明本次未见超出进程波动的明确雨景增量，不代表雨景能省内存或长期无泄漏，也未测独立显存。该样本不含另外开发中的新天空组件，不能当作联合版的整体占用结论。

优先保证功能，再做与风险相称的最小检查：`scripts/build.ps1 -Check` 覆盖冻结安装、前端 lint／构建、Go test／vet 与正式构建。涉及真实硬件时，先正常退出现用核心并确认颜色与亮度恢复，再独占运行显式验收入口；普通测试和浏览器预览不写真实显示器或音量。

诊断输出放 `build/diagnostics/`；清理 `build/` 前检查现用进程和登录自启，保留它们指向的包。前端使用项目级共享 pnpm store；改变目录层级后重新安装依赖链接，不清共享缓存。保留用户配置、个人校准和共享依赖缓存；清理一次性临时文件。阶段完成后仅做必要验证，部署正式版，再提交并推送本轮改动；不夹带工作区其他未完成改动。已合并／过时 worktree 自动清理，托管 worktree 用归档工具；唯一主工作区保留。成功部署后由 scripts/Remove-OldPackages.ps1 将本地 build/packages 中超过最近 5 个的旧包移入回收站；清理前一次性核对所有目标位于包目录内且非运行／自启路径，未知目录不删除；不清理远端历史。真实设备的目标状态、错误、Warning 和唯一自启项应在每次部署后重新核对。界面准则见[产品说明](PRODUCT.md)，本次验证状态与未测边界见[状态说明](STATUS.md)。

全局下拉菜单复用 `frontend/src/components/ui/select.tsx` 的 Radix UI Select，浮层通过 Portal 避免设置内容区裁切，样式定义在 `index.css`。设置导航忽略 combobox／option 内的方向键，应用 Esc 让位于打开的菜单；组件关闭后恢复触发器焦点。

## 云彩位置分布

首页已撤下临时云朵测试栏与 Takram／体积／卡通候选、对应资源和依赖。保留 pmndrs 三种原有云彩和旧版薄云增强；cloud-legacy.ts 不改。cloud-placement.ts 为三组现有组件计算原有分布、分区散布、错落高度、弧形、远近深度五种位置；同场景／样式使用固定种子，不因刷新重新随机，移动围绕基准位置缓慢漂移。形状、纹理、浓度、速度与72实例上限不改，不增加画布或依赖。默认仍为原有分布。

位置选择仅在非旧版云彩的天空设置中显示，四场景分别记忆，沿用自动保存／撤销。旧偏好缺少layout时回退original；未知layout也回退，不改写读取到的本地存储。旧版薄云与星星不受位置算法影响。

部署包 build/packages/20261116-004217-009；目标／专注保留与唯一自启证据 cloud-placement-20261116-update.json，验证记录及界面截图位于 build/diagnostics/cloud-placement/。

星星闪烁：star-twinkle.ts 仅适配pmndrs星点材质，初始化一次逐星相位／频率／幅度属性；取消默认共享尺寸脉冲，用独立明暗曲线保留星点形状。每帧只更新时间，闪烁滑条控制强度，0和减少动态效果常亮。云彩与旧版薄云不改。设置收起修正：clipPath完成收拢后才淡出，天空编辑内容不因open=false提前换页，关闭期间inert与pointer-events禁止操作。

## 连续场景过渡

设置页／场景栏共用 `settings-morph.tsx` 的空玻璃外框，Motion 阻尼弹簧保留反向时速度；上下文仅共享进度与两端矩形，ResizeObserver 随窗口／栏宽更新锚点。外框位置、尺寸、圆角、材质及阴影随同一进度插值；设置内容不缩放，仅裁切／淡入淡出；场景内容在最后 3.5% 形变中交接。保持设置挂载和草稿，立即切换 inert，不依赖延时定时器；无截图／画布／纹理缓存，卸载释放观察器。系统减少动态效果时直接跳至终态。逐帧证据 `build/diagnostics/settings-morph/frames.json` 覆盖开关、90ms 间隔五次反向、图标／图文胶囊与旧版栏，验证无两组内容重叠、外框有界及文字 transform 为 none；未实测系统减少动态效果与长期占用。

`ScenePanel` 以同步 ref 记录最新选择，按键和点击不依赖上一帧 React 状态；请求序号只允许最新手动请求结束等待，串行硬件中间回报不覆盖新目标，结束后恢复外部场景同步。仅增加常量状态，不增加画布／纹理／历史快照。`build/diagnostics/scene-input-fix/verification.json` 记录同帧正反向三次、两条中间回报与等待结束后的外部同步；浏览器使用真实组件和受控回报，不写硬件。

- `LiveSceneStage` 不再等待进行中或过时的加载结束：新目标取消旧图片加载，加载完成后再次核对最新目标；废弃请求不得清空新请求状态。中断时从最后已显示的进度与飞絮相位衔接，单次 GPU FBO 合成、不 `readPixels` 或 CPU 拷贝。
- 纹理按显示宽度生成且不超过 1672×941，RGBA 快照理论上限约 6.29 MB；中断瞬时最多三张场景纹理，过渡两张、空闲一张，另有共用 mask／飞絮图集，不常驻四场景。雨景后处理不写入快照，飞絮只修补新目标；快照失败保留当前画面。隐藏或减少动态效果时直接切到目标；卸载取消加载并释放纹理与上下文。硬件请求仍串行，取消画面过渡不等于取消在途硬件调用。
- 验收：快速三场景切换、真实 WebGL 晴天／雨天衔接与过时加载均通过，平均 8 位像素差 0.09～0.22，无 GL 错误；峰值 5、空闲 3、销毁 0 张纹理（均含共用 mask／图集）。证据为 `build/diagnostics/scene-interrupt/gpu-check.json`，正式构建日志见同目录 `production-build.log`。未验证长期 CPU／显存走势或所有机器的流畅度。

当前正式包为 `build/packages/20261116-043918-577/`；目标／专注保留、唯一自启及包清理见 `build/diagnostics/sky-demand-20261116-update.json` 与同前缀 retention 文件。发布通过临时源码副本使用已提交原生基线，仅叠加天空按需资源修改，未夹带工作区未完成的显示／恢复修改。
