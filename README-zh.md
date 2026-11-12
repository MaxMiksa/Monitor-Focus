<p align="center"><img src="docs/assets/hero-zh.svg" width="100%" alt="Monitors Focus"></p>

<br>

<p align="center">
  <a href="https://github.com/MaxMiksa/Monitors-Focus-Assistant/releases/tag/v2.0.0"><img alt="version" src="https://img.shields.io/badge/version-2.0.0-125cd0?style=flat-square"></a>&nbsp;
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-4a5a70?style=flat-square">&nbsp;
  <img alt="runtime" src="https://img.shields.io/badge/runtime-.NET%2010%20%2B%20WebView2-512BD4?style=flat-square">&nbsp;
  <img alt="license" src="https://img.shields.io/badge/license-MIT-3f8f5a?style=flat-square">&nbsp;
  <a href="README.md"><img alt="English" src="https://img.shields.io/badge/English-README-8b9bb0?style=flat-square"></a>
</p>

<p align="center">常驻核心负责显示器控制，面板需要时再打开。<br>亮度、色温、场景和时间计划，都在同一个窗口里完成。</p>

## 它解决什么问题

Windows 只提供一个整体亮度，外接屏和笔记本内屏无法分别调节；色温又通常藏在每台显示器不同的 OSD 菜单里。

Monitors Focus 把这些操作收进一个窗口：每块屏独立调节亮度，按校准曲线或比例联动，外接屏与笔记本内屏通过软件 Gamma 调整冷暖，再把常用组合存成场景和时间计划。

## 控制面板

<p align="center"><img src="docs/assets/panel-controls.png" width="620" alt="控制面板"></p>

<p align="center"><sub>真实双屏：AOC U27G4 使用 DDC/CI，笔记本内屏使用 WMI。界面数值表示目标值，硬件失败会单独提示。</sub></p>

## 主要能力

| 能力 | 说明 |
| --- | --- |
| 双屏亮度 | 每块屏独立写硬件背光；外接屏使用 DDC/CI，内屏使用 WMI |
| 亮度联动 | 已校准设备对按分段曲线双向联动；同一曲线暂用于所有色温，内屏触顶时保持 100%；其他设备保留比例绑定 |
| 逐屏色温 | SDR 下统一使用软件 Gamma，让兼容的外接屏和内屏独立变暖并恢复原色；K 值为近似标尺，暖色幅度受系统范围限制 |
| 内屏冷暖补光 | 完成四点观感校准后，内屏变暖时自动补偿背光，尽量保持亮度目标；主屏不补光，达到上限会提示 |
| 每日计划 | 按时间节点切换场景，并以缓入缓出方式渐变；跨午夜连续，手动调节可接管到下一节点 |
| 场景 | 保存逐屏亮度、色温和专注规则，可从快捷面板快速切换 |
| 专注 | 鼠标离开副屏后显示遮罩；可暂停、恢复，并支持副屏全屏或最大化时保持不遮挡 |
| 边缘滚轮 | 贴顶部调亮度、贴底部调系统音量，每格 2%；独立开关默认关闭，亮度遵循已有联动，调节后显示系统原生浮层（亮度显示内屏值） |
| Alt + 边缘滚轮 | 顶部调色温，每格 100 K；底部只调前台软件音量，每格 2%，统一百分比并保留静音；轻量数值和进度条；通用设置可选 Alt／Ctrl／Shift，保存后生效 |
| 界面语言 | 简体中文、English 和跟随系统；即时预览，保存后应用到面板与托盘 |
| 登录自启 | 只保留一条自启项，指向自包含核心 |
| 面板按需 | 关闭面板只退出界面进程，控制核心继续执行计划、专注和已开启的边缘滚轮 |

## 快速开始

1. 下载 [MonitorsFocus-v2.0.0-win-x64.zip](https://github.com/MaxMiksa/Monitors-Focus-Assistant/releases/download/v2.0.0/MonitorsFocus-v2.0.0-win-x64.zip) 并解压。
2. 运行 `desktop/MonitorsFocus.WebHost.exe`，并保持 `core/` 与 `desktop/` 同级。
3. 在设置中打开登录自启。注册项指向 `core/MonitorsFocus.exe --center --background`，登录后静默运行。

自包含包已包含 .NET 运行时，只需系统具备 Microsoft Edge WebView2 Runtime。Windows 11 通常已预装。

GitHub 上的 v2.0.0 是公开基线；当前仓库包含尚未发布到远端的后续改进。

## 运行结构

<p align="center"><img src="docs/assets/architecture.svg" width="100%" alt="运行结构"></p>

- 设备句柄只由 C# 核心持有，面板不直接访问硬件。
- WebView2 桥只开放白名单命令，并校验消息来源。
- 每块设备串行执行命令；等待超时不代表底层调用已经取消。
- 关闭面板会释放 WebView2 进程，核心继续执行计划、专注与已开启的边缘滚轮。

## 验证范围

| 项目 | 当前状态 |
| --- | --- |
| Web 类型检查、生产构建、Oxlint | 2026-11-12 通过，0 警告 0 错误 |
| 解决方案 Release 构建 | 2026-11-12 通过，0 警告 0 错误 |
| 自动检查 | 2026-11-12，59 项通过，含 即时预览与异步校正、增强模式隔离、进程树、色温联动、原生浮层及既有检查 |
| 边缘滚轮 | 用户确认基础调节正常；系统原生浮层实拍通过；两个不同音量的测试会话统一到 50%，静音及其他会话／总音量保持。增强浮层的复用、自动隐藏和连续绘制资源检查通过；应用音量短期复用当前软件控制项，逐格响应、混音器改动接续及停滚释放短测通过；真实手感、浏览器音频进程与切换输出待复验 |
| 真实双屏亮度读取 | 已验证 |
| 外屏硬件色温写入与原色恢复 | 已在 AOC U27G4 验证 |
| 双屏软件色温 | AOC 与 BOE 内屏的写入、逐屏隔离和恢复通过；用户确认两屏变暖及内屏恢复正常 |
| 全屏或最大化时保持亮屏 | 原生窗口识别通过，真实硬件联动待验收 |
| 比例绑定、休眠重连、混合 DPI、长时间运行 | 待验收 |

本机运行包已更新并启用 AOC／BOE 跨屏分段曲线，暂用于所有色温，额外暖色补光未启用；双屏 Gamma 调色与最新场景页精简也已打包，场景页尚未完成新的交互复验。GitHub 下载包未更新。完整边界见[验收说明](docs/ACCEPTANCE.md)。

当前本地构建为 `publish/control-center-20261112-194021/`，2026-11-12 已正常重启，自启同步更新；两个已开启的滚轮开关及当前屏幕设置保持。增强模式的数值／进度在输入时立即更新，实际调节异步执行并校正；首次进入软件起始音量未知时先显示“…”等待读数，失败隐藏并提示。浮层复用核心内的一个按需窗口，不增加常驻进程。新配置默认关闭开关；可在“设置 → 通用”分别开启并保存。旧包文件保留，未创建新发布版本。

## 文档

| 文档 | 内容 |
| --- | --- |
| [文档索引](docs/INDEX.md) | 全部主文档、历史归档与素材入口 |
| [产品说明](docs/PRODUCT.md) | 产品范围、用户行为和状态规则 |
| [开发文档](docs/DEVELOPMENT.md) | 架构、构建、配置、硬件与打包 |
| [设计文档](docs/DESIGN.md) | 页面结构、设计参数与组件规则 |
| [验收说明](docs/ACCEPTANCE.md) | 当前验证结果和待验收边界 |

## 从 v1.0.0 升级

先退出正在运行的旧版托盘进程，避免单实例锁阻止新版核心启动。首次启动会把旧 `settings.json` 备份为 `settings.json.pre-center.bak`，并继承登录自启、专注延迟和语言偏好。

新版专注只显示遮罩，不再降低硬件亮度。旧配置中的 `FocusBrightness` 会被忽略，下次保存时移除。不带 `--center` 启动仍进入 v1 的鼠标跟随遮罩模式，保留原有调光行为，仅用于兼容。

## 参与开发

```powershell
./scripts/build.ps1
./src/MonitorsFocus.WebHost/bin/Release/net10.0-windows/MonitorsFocus.WebHost.exe
```

需要 .NET 10 SDK、Node.js 24.11.1（24 LTS）、pnpm 12.16.1 和 WebView2 Runtime。构建使用 `pnpm install --frozen-lockfile` 恢复 Web 依赖，有效 JS 锁为 `src/MonitorsFocus.Web/pnpm-lock.yaml`。pnpm 未加入 PATH 时，可向构建脚本传入 `-Pnpm D:\Apps\pnpm\12.16.1\pnpm.exe`。浏览器预览、开发宿主与打包说明见[开发文档](docs/DEVELOPMENT.md)。

## 许可与联系

MIT License。欢迎提交 Issue 和 Pull Request。

Zheyuan (Max) Kong · Carnegie Mellon University

[kongzheyuan@outlook.com](mailto:kongzheyuan@outlook.com) · [zheyuank@tepper.cmu.edu](mailto:zheyuank@tepper.cmu.edu)

后台远程会话重置前台色温时，新版代码约每 3 秒核对并恢复原色基线上的暖色；仅允许前台物理会话控制已确认身份的屏幕。本机运行核心已更新，AOC 实机重置后约 0.8 秒自动恢复；后台识别画面隔离仍需实机复验。
