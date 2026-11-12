# 开发与构建

本文说明项目如何实现、运行、调试和打包。产品行为见[产品说明](PRODUCT.md)，界面规范见[设计文档](DESIGN.md)，验证状态见[验收说明](ACCEPTANCE.md)。

## 环境要求

- Windows 10 / 11 x64。
- `global.json` 指定的 .NET 10 SDK。
- Node.js 24.11.1（24 LTS）、pnpm 12.16.1；版本声明位于 Web 包的 `.node-version` / `package.json`。
- Microsoft Edge WebView2 Runtime。

运行自包含产物不需要另装 .NET 运行时，也不需要 Node 或 Vite 常驻。

## 工程结构

| 目录或文件 | 职责 |
| --- | --- |
| `src/MonitorsFocus` | 常驻核心、DDC/WMI、专注遮罩、配置、自启和 v1 兼容入口 |
| `src/MonitorsFocus.Core` | 协议、比例计算、每日计划纯计算及共享文案 |
| `src/MonitorsFocus.Web` | React / TypeScript 界面、设计参数和前端组件 |
| `src/MonitorsFocus.WebHost` | WinForms 窗口、WebView2 初始化、本地资源和消息桥 |
| `tests/MonitorsFocus.Tests` | 无第三方测试框架的假设备与纯计算检查 |
| `scripts/build.ps1` | Web 与 .NET 构建，以及可选自包含打包 |

生产包包含 `desktop/` 和 `core/` 两个目录。入口为 `desktop/MonitorsFocus.WebHost.exe`；核心位于 `core/MonitorsFocus.exe`。

## 完整构建与启动

```powershell
./scripts/build.ps1
./src/MonitorsFocus.WebHost/bin/Release/net10.0-windows/MonitorsFocus.WebHost.exe
```

本机 .NET 未加入全局 PATH 时：

```powershell
./scripts/build.ps1 -Dotnet D:\Apps\dotnet\dotnet.exe -Pnpm D:\Apps\pnpm\12.16.1\pnpm.exe
$env:DOTNET_ROOT = 'D:\Apps\dotnet'
$env:DOTNET_ROOT_X64 = 'D:\Apps\dotnet'
./src/MonitorsFocus.WebHost/bin/Release/net10.0-windows/MonitorsFocus.WebHost.exe
```

如果旧版托盘正在运行，先退出旧版，避免单实例锁阻止新版核心启动。

## 运行链路

```text
React UI
  -> WebView2 postMessage
  -> WebHost 来源与动作白名单
  -> 当前用户命名管道
  -> MonitorsFocus 常驻核心
  -> DDC/CI 或 WMI 亮度，以及逐屏 GDI Gamma 调色
```

- Web 前端不直接持有硬件句柄。
- WebHost 只接受明确列出的请求，不提供通用 Shell 或文件系统执行能力。
- 关闭面板会取消前端等待并释放 WebView2；核心继续执行计划。
- `temperature` 请求可携带 `Id` 只调整对应屏幕；省略 `Id` 时兼容旧版对全部支持屏幕调色的调用。

## 前端开发

```powershell
pnpm --dir src/MonitorsFocus.Web install --frozen-lockfile
pnpm --dir src/MonitorsFocus.Web run dev
```

Web 包只维护 `pnpm-lock.yaml` 为有效 JS 锁。[原 npm 锁](history/npm-web-package-lock-2026-11-04.json)仅保留历史与回退依据，不用于日常安装。`pnpm-workspace.yaml` 采用 isolated 链接及全局虚拟存储：包内容和依赖图位于同盘 `D:/.pnpm-store/v11`，项目 `node_modules` 链接至对应依赖图；`.pnpm-cache` 保存离线策略所需元数据。移走 `node_modules` 后可用 `pnpm install --offline --frozen-lockfile` 重建，前提是共享存储和本地元数据仍完整。此配置针对当前 Windows D 盘工作区；换盘或换机时需调整项目级 `storeDir`，不能直接搬运旧 `node_modules`。不修改全局 PATH、Corepack 或 pnpm 配置，也不清理共享存储。

依赖安装启用 `strictDepBuilds`，当前 Windows 依赖无需安装脚本，因此 `allowBuilds` 为空；后续只有核对必要性后才允许明确版本的脚本。`pnpm-lock.yaml` 同时包含包管理器与业务依赖两个 YAML 文档，审计时分别读取，不能把 pnpm 自身依赖算作业务升级。

浏览器打开 `http://127.0.0.1:5173/?preview=1` 会显示带明确标识的示例数据预览，不连接硬件，也不把失败回退成演示成功。

真实热更新调试运行 WebHost 并传入 `--dev`：

```powershell
./src/MonitorsFocus.WebHost/bin/Release/net10.0-windows/MonitorsFocus.WebHost.exe --dev
```

开发模式只允许固定本地源并开启 DevTools。普通启动使用打包到 `wwwroot` 的静态资源，不依赖开发服务器。

## 命令与状态模型

- 每块物理设备只有一个串行执行通道。
- 等待超时只让 UI 继续响应，不表示底层 DDC/WMI 调用已经取消。
- 释放句柄前必须等在途调用结束。
- 慢设备只保留最新目标，避免滑条操作堆积请求。
- 亮度只写实际变化的合法档位；RGB 增益不变时跳过写入。
- 控制中心为 DDC/WMI 亮度设备独立附加 `GammaColorDevice`，复用串行 worker；不同时写硬件 RGB。调色失败单独记录，不阻断后续亮度请求。
- 设备重新枚举后，旧会话结果不得覆盖新会话状态。
- UI 状态来自核心快照；硬件失败、部分应用和恢复失败必须单独上报。

## 屏幕边缘滚轮

`TopEdgeBrightnessEnabled` / `BottomEdgeVolumeEnabled` 旧配置缺省为 false。`EdgeWheelService` 在独立消息循环线程安装低级鼠标钩子，只做物理像素命中检查与最多 128 条入队；首条请求唤醒核心，不提高空闲轮询频率。`EdgeWheelGesture` 累积有符号 120 单位滚轮刻度，换屏／换边缘、切换 增强模式／前台窗口、离开或超过 500 ms 停顿清除余量。除已选单键外的修饰键、拖拽、注入输入、水平滚轮及非控制台会话放行。

`EdgeWheelModifier` 为 `alt`（默认）、`ctrl` 或 `shift`，旧配置缺省 Alt，不引入配置版本迁移；保存拒绝未知值。只按选定按键时切换到色温／前台软件音量，其他单键及组合键（含 AltGr）放行。该字段随不可变钩子配置一起更新，换键使旧队列失效并清余量，现有音量代次及反馈同步失效，不新增线程／监听器。色温按 100 K 步进复用现有串行设备通道、联动和手动保持。软件音量在钩子中只捕获前台 HWND／PID，在音量工作线程通过 `IAudioSessionManager2` 和 `ISimpleAudioVolume` 处理当前软件的会话；枚举活动输出端点，覆盖独立音频路由。同名进程只在已验证的同一进程树内匹配；排除系统声音、过期和跨进程归属不明确的会话。执行前重检焦点、会话、进程身份和开关代次，不回退到主音量；部分失败如实报告。参考 [Windows 会话音量接口](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nn-audioclient-isimpleaudiovolume)。

增强反馈使用 `EdgeFeedbackForm`：核心 UI 线程按需创建并复用一个小型 WinForms/GDI+ 窗口，只有可见时启用 1.5 秒隐藏计时器，不启动 WebView、额外进程或动画循环。色温输入立即显示目标 K 值，设备通道异步调整，失败隐藏并报告。应用音量通过 UI 专属的 `ApplicationVolumePreview` 立即预测目标进度；只保留当前软件及最多 128 个值类型待确认输入，存储按需增长并复用，不持有音频资源。首次起点未知先显示“…”和空轨道，实际读回后从确认值按顺序重放更晚的输入；旧确认不会覆盖更新的滚轮意图，外部混音器变化会校正预览。回调仅保留最新值并合并 UI 唤醒，不延长最后输入起算的 1.5 秒显示期限；切换模式／目标、失焦、禁用、重检或错误隔离旧反馈，失败清除预测并提示。应用音量仍以当前匹配会话的最高值为起点增减 2 个百分点，统一写入全部匹配会话，读回验证单一百分比及全静音状态。音量队列即时合并同代次、同一前台窗口／进程、同方向的相邻请求，首次或短期缓存刷新时才枚举进程及会话；不等待收集输入，不跨反向滚动合并，保留边界处的方向行为。当前软件会话按下文短期复用，创建、使用和释放保持在同一 MTA 线程，不新增后台监听。字体和窗口资源复用、退出释放，绘制对象及时释放。

亮度复用 `ApplyBrightness`、手动保持和设备串行通道，独立于色温补光。`SystemVolume` 通过 Core Audio 的 render / multimedia 默认端点在独立工作线程读取并调整主音量；主音量每次重新获取端点。应用音量只短期复用当前窗口／进程的一组已确认会话和对应进程句柄，停滚 500 ms 后释放，连续滚动最多复用 1 秒后重新发现，覆盖后续新会话／路由；切换目标、调主音量、设置代次变化、错误或退出时释放。每格检查前台身份、进程存活和会话状态，读取当前真实音量再写入及读回，保留混音器的外部修改及静音。音量线程使用一个可阻塞等待的 MTA 工作线程，替代原异步工作循环，保证缓存 COM 引用在同一线程创建／使用／释放；空闲无轮询，只有缓存存在时才有一次有界超时等待，不增加进程或全局监听。队列有界，关闭开关后通过代次丢弃旧音量请求并唤醒释放缓存；重检时禁用监听并丢弃旧设备请求。关闭全部开关时卸载钩子，退出先停止监听与音量工作线程，再释放显示器。错误进入快照警告与限频托盘提示。参考 [Microsoft 低级鼠标钩子说明](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelmouseproc)与 [Core Audio 主音量接口](https://learn.microsoft.com/en-us/windows/win32/api/endpointvolume/nn-endpointvolume-iaudioendpointvolume)。

`NativeHardwareOsd` 在独立工作线程通过 Immersive Shell 的 `IFlyoutDisplay` 唤起系统浮层（音量 0、亮度 3；[调用参考](https://github.com/Arora-Sir/AutoHotKey-Windows-Scripts/blob/master/AllScripts/Brightness.ahk)）。这是未公开接口，系统更新可能改变行为；不可用时限频报告，不回退到模拟按键或改动设备来触发提示。队列只保留最新类型，关闭、重检和退出丢弃待处理提示。音量写入后提示；亮度等待目标屏及联动内屏的串行设备任务完成，合并快速滚动，失败不提示成功。浮层仅由边缘滚轮触发，不跟随计划或面板滑块。按用户选择，亮度显示系统内屏背光，不承诺反映外屏或色温补偿前的正常亮度。

`dotnet run --project tests/MonitorsFocus.Tests -c Release --no-build -- --volume-probe` 只读取默认播放音量；`--app-volume-probe` 只读取前台应用的可控会话数量。`--app-audio-check` 显式创建临时前台窗口、静音流及一个从不启动播放的独立 WASAPI 会话，只调整测试进程自身两个会话，核对 48%／60% 统一到 50%、取消不写、41 格连续滚动合批及 100% 触顶后反向回到 98%、12 格独立输入的逐格反馈耗时、缓存中的外部混音器改动和停滚释放、其他会话及总音量不变、静音保持，最后恢复测试会话并关闭窗口；不作为默认测试运行。`--edge-feedback-check [截图目录]` 只显示测试数据，检查焦点、窗口复用、自动隐藏及两批各 2000 次绘制的内存／句柄，不写显示器或音量；截图不代表真实调节结果。`--osd-probe volume` / `--osd-probe brightness` 只唤起对应系统浮层，不写亮度、音量或静音。真实滚轮、混合 DPI、热插拔与切换输出的验收见 [ACCEPTANCE.md](ACCEPTANCE.md)。当前自包含构建为 `publish/control-center-20261112-194021/`，已正常重启并更新登录自启；旧包保留。

## 配置与迁移

新版配置位于：

```text
%AppData%\Monitors-Focus\control-center.json
```

旧版配置为同目录的 `settings.json`。首次启动且新配置不存在时：

1. 将旧文件备份为 `settings.json.pre-center.bak`。
2. 继承登录自启、专注等待时间和语言偏好。
3. 原子写入 `control-center.json`。
4. 保留旧文件和已有备份，供 v1 兼容入口使用。

迁移不继承旧版硬件调暗值。旧 `FocusBrightness` 读取时忽略，下次保存时移除。读取或迁移失败会显示错误，不按默认设置修改注册表中的登录自启。

配置保存检查 Revision。其他操作已经推进 Revision 时，旧草稿保存会提示冲突，不能覆盖新设置。

## 设备恢复

- 休眠恢复、热插拔或重新检测时，按稳定设备标识保留本次会话的色温目标。
- 新句柄先恢复原色基线，再重新应用用户目标。
- 首次色温探测失败时保留请求，后台继续探测；成功后重新应用。
- 断开设备的目标保留到核心退出；恢复原色会同时清空离线设备的保留目标。
- 活动计划仍按时钟接管；手动保持不会因无关设置保存提前结束。
- 控制中心退出时移除专注遮罩并恢复原色，保留最新正常亮度。

## 逐屏 Gamma 调色

- `NativeGammaRamp` 按 GDI 显示名建立独立 DC，`DisplayColorMode` 用 CCD 当前映射确认单一目标和 SDR。查询失败、复制目标、HDR 或高级颜色时拒绝调色。
- `GammaColorDevice` 首次实际调色前保存完整的 3×256 原始表；Kelvin 转 RGB 为近似值，以 6500 K 归一化。6500 K 和空目标均恢复基线并释放颜色所有权。
- GDI 要求每项与线性原值的偏差不超过 32768。较暖端统一缩小变换幅度，不裁剪单个曲线采样；此范围内数值为冷暖标尺，不保证物理色温。参考 [微软 Gamma 限制](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/using-gamma-correction)。
- 每次变化写入后读回核对。暖色目标未变化时约每 3 秒通过原串行 worker 核对当前表；仅退回保存的原色基线时重新应用，表未变化只读不写，未知外部颜色停止调色并报告冲突。正常恢复仅在当前表仍等于本应用最后写入的表时进行。
- 显示变化和唤醒复用现有重新枚举流程。正常退出可恢复；进程被强制结束、崩溃重启和长时间冲突恢复尚未验收。
- 构建 Release 测试后运行 `scripts/Test-DisplayGamma.ps1` 做只读探测；`-Interactive -DisplayName '\\.\DISPLAY1' -Kelvin 2700` 显示手动切换的白色参照窗。显示编号会变化，先用只读输出确认设备身份。`-Dotnet D:\Apps\dotnet\dotnet.exe` 可指定本机 SDK。
- 非交互 `-Apply` 会短暂改变真实屏幕颜色并恢复；诊断直接调用生产调色类，普通自动检查不写真实屏幕。Gamma 读回只能证明颜色表状态，实际画面需用户观察。

### 色温与亮度的耦合边界

`WarmRamp` 通过衰减绿、蓝通道变暖。固定 `LinkWeights` 没有描述各屏的背光响应曲线；单点比例匹配不能保证变暖或调暗后继续匹配。控制中心现将用户亮度目标和补偿后的背光目标分开，仅对已校准的内屏联合计算；外接屏仍直接使用用户亮度目标。

以线性基线、约 2.2 的显示响应和 sRGB 亮度权重估算，当前 4500 K、3500 K 变换后的白色亮度约为原色的 76%、62%。这些是算法估算，不是本机实测亮度，也不是精确的主观亮度预测；不能把其倒数直接乘在背光百分比上当作可靠补偿。

`ControlSettings.TemperatureBrightnessCalibrations` 按稳定设备标识保存四个主观匹配点：两档参考亮度，各配 4500 K 与 2700 K 的实际背光。`TemperatureBrightnessCalibration` 对参考亮度和冷暖插值，6500 K 为零补偿；高于最高参考亮度时保持最后测得补偿量，低于最低参考亮度时渐缩到零。输出不低于用户目标，不超过 100%，超限通过现有警告区反馈。旧配置默认为空，不自动启用。

CCD 目标的内置、LVDS、嵌入式 DisplayPort/UDI 类型确认内屏身份，校准本身也必须匹配设备标识。保存校准不改场景定义或联动权重；`BacklightTarget` 只用于快照诊断，不是实测亮度。设置更新后目标去重包含补偿结果，无需重新扫描即可应用新曲线。

串行 worker 升亮前先变暖，降亮后再变冷；恢复原色、正常退出时回到最新正常亮度。调色失败时撤回补光，保留亮度控制。休眠与重检通过现有关闭、恢复、重新枚举流程处理，实际长时间观感及崩溃行为仍待验。

`scripts/Calibrate-TemperatureBrightness.ps1` 使用正在运行的控制核心在内屏显示白色参照，暂时解除比例绑定并按需暂停专注。每步手动比较原色与暖色，读取 WMI 背光确认记录值；已有补偿在重校准期间临时暂停。完成或取消后恢复原亮度、色温和联动。结果保存到 `publish/temperature-brightness-calibration.json`，作为校准数据保留；更新核心后运行 `scripts/Apply-TemperatureBrightnessCalibration.ps1`，通过带最新 Revision 的设置保存请求写入该设备的校准项。配置在磁盘上自动保留旧版本备份。

新颜色管线可以改善精度和兼容性，但不能消除暖白点下的物理亮度上限。参考 [Lunar 的曲线同步方法](https://lunar.fyi/pro)、[ArgyllCMS 的白点、亮度和响应曲线校准](https://www.argyllcms.com/doc/dispcal.html)。

## 场景与计划执行

### 跨屏亮度联动

`ControlSettings.BrightnessLinkCalibration` 可选保存一对稳定设备标识及单调分段点列，旧配置默认为空；校准与场景行为、`LinkWeights` 和色温补光数据分开保存。`BrightnessLinkCalibration` 做正向插值、反向插值和触顶处理，写入目标四舍五入到整数。曲线覆盖外屏 0–100%，内屏可有非零起点与高亮平台；平台反向调节保留范围内的当前外屏值。

`Linked` 开启时，匹配设备对优先使用曲线，手动拖动任一屏都可联动；缺少配对设备时只改当前屏，不回退到其他屏的比例。内屏调到曲线覆盖范围以下时，外屏固定最低值，内屏仍可继续调暗。其他设备保留旧比例运算。启用联动以当前外屏对齐内屏；场景和计划只在各自行为开启联动时使用曲线，先插值外屏目标，再求内屏目标，不直接插值两个端点的内屏背光。

本机数据保存在 `calibrations/aoc-boe-brightness.json`，包含 11 个观感匹配点与外屏 100%／内屏 100% 的触顶策略。用户于 2026-11-03 确认暂将同一曲线用于所有色温；暖色仍缺少独立观感数据，当前不启用额外内屏补光。运行支持此字段的新核心后，使用 `scripts/Apply-BrightnessLinkCalibration.ps1 -EnableLink`，按当前快照与 Revision 保存并启用；脚本确认两个稳定设备均在线，核心验证数据并原子备份配置。个人数据不写入程序默认值。

场景数据和执行顺序的产品规则见[产品说明](PRODUCT.md)。实现上注意：

- 场景在 `Targets` 之外保存行为数据；读取旧场景时在内存中补齐，不立即改写用户文件。
- 手动切换先保存变化后的当前规则，再应用正常目标；保存失败时不宣称切换成功。
- 计划在首次接管、恢复计划或进入新节点时应用场景规则。
- 渐变期间只更新正常目标，不重复保存配置或重置专注计时。
- 计划每秒按当前时间直接求值，不展开多日时间线，也不保存逐帧序列。
- 跨午夜按本地时间判断；错过节点直接从当前时刻求值。

## 全屏检测

开启“副屏全屏或最大化时保持亮屏”后，核心每 250 ms 枚举桌面顶层窗口：

- 全屏使用窗口可见边界与整屏边界匹配，容差为 2 个物理像素。
- 最大化同时检查 Windows 窗口状态和所在显示器。
- 检测所有顶层窗口，不限于前台窗口。
- 最小化、隐藏、DWM 隐藏的其他虚拟桌面窗口、桌面、任务栏和本应用遮罩不视为占用。
- 最后一个符合条件的窗口结束后，从该时刻重新计算完整专注等待时间。

坐标使用 PerMonitorV2 逻辑。检测只影响遮罩，不写亮度。

相关系统接口：

- [EnumWindows](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enumwindows)
- [DwmGetWindowAttribute](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/nf-dwmapi-dwmgetwindowattribute)

## 本地化

统一文案位于 `src/MonitorsFocus.Core/strings.json`：

- 中文原文作为键，英文作为值。
- 动态参数使用 `{0}`、`{1}`。
- Core 内嵌同一份资源，Web 导入并检查键类型。
- 不增加散落的翻译表。

语言偏好保存为 `system`、`zh-CN` 或 `en`。系统语言为中文（含繁体）时显示简体中文，其他语言回退 English。宿主在加载首屏前读取语言，启动失败提示也跟随该偏好。

用户数据不作为翻译键。新默认场景通过 `DefaultName` 标记随语言变化；用户改名后清除标记，已有自定义名称不推断、不重命名。

## 登录自启

唯一注册表项：

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Run\MonitorsFocus
```

值为：

```text
"<executable>" --center --background
```

核心同时检查并清理历史条目 `MonitorsFocus.ControlCenter`。启动时校正条目路径和启用状态；关闭自启时删除 Run 条目及 `StartupApproved` 状态。

自启必须指向自包含包 `publish/app/core/MonitorsFocus.exe`，不能用 `bin/Release` 的框架依赖输出：登录会话没有开发机的 `DOTNET_ROOT`。

## 检查与打包

```powershell
pnpm --dir src/MonitorsFocus.Web run lint
dotnet run --project tests/MonitorsFocus.Tests -c Release
./scripts/build.ps1 -Package
```

`pack.bat` 代理到同一 PowerShell 入口。打包输出到新的 `publish/control-center-时间戳/`，不删除已有发布目录；构建不签名、不上传、不发布。

完整构建前应先确认 Vite 开发服务器是否由自己启动，避免依赖恢复遇到被占用的原生文件；不要擅自停止已有用户进程。测试覆盖和当前结果见[验收说明](ACCEPTANCE.md)。

## 硬件记录

本机双屏为 AOC U27G4（2560×1440，DisplayPort）与笔记本 BOE 内屏：

| 项目 | AOC U27G4 | BOE 内屏 |
| --- | --- | --- |
| DDC 亮度（0x10） | 可读写 | 不可用，走 WMI |
| 对比度（0x12） | 可读写 | 不可用 |
| RGB 增益（0x16 / 0x18 / 0x1A） | 可读写 | 不可用 |
| 直接色温（0x0E） | 不支持 | 不支持 |
| 色温步进（0x0C） | 可读 | 不可用 |
| `GetMonitorCapabilities` | 始终失败 | 始终失败 |
| SDR Gamma 读取、写入、恢复 | 通过；用户确认变暖 | 通过；白色参照交互测试确认变暖与恢复 |

6500 K 下的两屏主观亮度对照（用户提供并确认记录完整，2026-11-02；以下最新数据替代先前记录，不代表实测 nits）：

| AOC 背光百分比 | 笔记本背光百分比 | 状态 |
| --- | --- | --- |
| 0 | 25 | 用户观感对照 |
| 5 | 35 | 用户观感对照 |
| 10 | 45 | 用户观感对照 |
| 20 | 55 | 用户观感对照 |
| 30 | 65 | 用户观感对照 |
| 40 | 70 | 用户观感对照 |
| 50 | 75 | 用户观感对照 |
| 60 | 80 | 用户观感对照 |
| 70 | 85 | 用户观感对照 |
| 80 | 90 | 用户观感对照 |
| 95 | 100 | 用户观感对照 |
| >95 至 100 | 100 | 用户确认的触顶策略，不保证继续等亮 |

设外屏背光百分比为 x，内屏基准背光百分比为 y，分段模型如下；四段连续，精确通过全部 11 个匹配点，实际写入时四舍五入到整数。

| 外屏 x 范围 | 内屏 y |
| --- | --- |
| 0 ≤ x ≤ 10 | 2x + 25 |
| 10 < x ≤ 30 | x + 35 |
| 30 < x ≤ 80 | 0.5x + 50 |
| 80 < x ≤ 95 | (2x + 110) / 3 |
| 95 < x ≤ 100 | 100 |

这组数据不能用单一比例表示：外屏最低背光不等于零发光。6500 K 基准曲线及高亮触顶策略已完整记录，并已实现独立于 `RatioBinding` 的设备对曲线。按 2026-11-03 用户决定，暂在所有色温使用同一曲线；这不代表已测量暖色或完成内屏色温补光校准，后续暖色补光应在内屏基准目标之上单独计算，外屏不补光。

2026-11-03 用户另反馈内屏轻微偏绿，具体发生色温与修正量未确认；后续单独检查绿／品红偏色，不将亮度匹配数据解释为 RGB 校准结果。

旧硬件 RGB 路线的实现注意（控制中心现已统一使用 Gamma）：

- 新句柄第一次 VCP 事务常被 NAK；打开设备后先做丢弃读并等待 150 ms。
- 写入 0x14 的用户预设值 `0x0B` 后读回可能为 `0x01`，恢复时必须写回实际读到的预设值。
- 色温能力不作为一次性判定。首次读失败后按 2 秒、6 秒间隔继续探测，探测走同一串行 worker。

更多测量背景见[历史性能记录](history/2026-10-31-runtime-memory.md)。

### 前台物理屏幕控制边界

核心拒绝在非物理控制台会话启动，桥拒绝其他会话的客户端。PhysicalDisplayScope 在 Gamma、DDC 和 WMI 写入（含恢复）前检查当前物理控制台会话及打开时保存的 PnP 身份；编号重新指向其他设备、身份未知或控制台切换时拒绝写入。不会切换到 RDP 会话枚举或恢复其颜色。此保护约束应用的目标选择；后台截图像素隔离仍须在实际驱动与采集链上验收。
