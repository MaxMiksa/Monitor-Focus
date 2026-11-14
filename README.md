# 🖥️ Monitors Focus

面向 Windows 的显示器控制中心：逐屏调节亮度和色温，保存场景与时间计划，按需开启专注遮罩和屏幕边缘滚轮。常驻 Go 核心负责控制，面板打开时才创建界面；关闭面板后，后台策略继续运行。

## ✨ 主要能力

- **逐屏亮度与冷暖**：外接屏通过 DDC/CI、笔记本内屏通过 WMI 调背光；兼容的 SDR 屏幕通过软件 Gamma 独立调色并恢复原色。
- **亮度联动**：可为一对已校准屏幕保存观感匹配曲线；曲线属于设备对，不是所有设备的默认值。
- **场景与每日计划**：保存逐屏目标和行为规则，按时间节点缓入缓出；手动调节保持到下一节点。
- **专注**：鼠标离开受控副屏后显示遮罩，不降低硬件亮度；支持暂停和副屏全屏例外。
- **屏幕边缘滚轮**：顶部调亮度、底部调系统音量；配合所选增强按键可逐格调色温或前台软件音量。
- **按需面板与语言**：关闭窗口释放 WebView2，核心仍驻留；界面支持简体中文、English、跟随系统，托盘菜单当前使用中文。
- **沉浸式场景面板**：固定 16:9 无边框窗口，早 / 中 / 傍晚 / 夜四个可点场景共用一片空间；默认用同一机位画面做原地实时换光，可在「通用」设置切回原来的整页换肤。无文字、无组件的纯底图上只浮一条纯圆场景胶囊，左右键或 A / D 切换场景，点击上箭头或 ↑ / W 展开玻璃设置浮层。当下、场景、渐变、专注、通用在原底栏位置紧凑切换，自动保存并支持撤销／重做；↓ / S / Esc 收起，首页 Esc 关闭到托盘。无顶部窗口栏，保留隐形顶部拖动区，并尊重系统「减少动态效果」。空气透明度可调 0%–100%，界面统一使用随包分发的 Noto Sans / Noto Sans SC。

当前版本面向 Windows 10/11 x64，需要 Microsoft Edge WebView2 Runtime；运行时不需要 Node、pnpm 或 Go。色温是近似冷暖标尺，不是仪器测量值；HDR、高级颜色或无法确认身份的屏幕不进入 Gamma 调色。

## 🚀 开始使用

当前 Go 版从本仓库源码构建；GitHub 既有旧版发布包不代表当前实现。按下方命令生成包后，运行 `MonitorsFocus.Go.exe`。首次打开会创建控制面板和托盘；在「通用」设置中可启用登录自启。软件只保留一条自启项：

```text
MonitorsFocus.Go.exe --mode native --hardware --production --background
```

正式包请放在稳定的独立目录，不要在更新时覆盖正在运行的 exe。正常退出会保留最新正常亮度、撤回内屏补光并恢复原色；请勿让两个会写显示器的核心同时运行。

## 🛠️ 本地构建

```powershell
./scripts/build.ps1 -Check
./scripts/build.ps1 -Check -Package
```

前者生成 `build/MonitorsFocus.Go.exe`；后者再复制到 `build/packages/时间戳/MonitorsFocus.Go.exe`。构建不会自动部署、提交或发布。包位置以实际生成结果为准；更新运行中的程序使用 `scripts/Update-NativeGo.ps1 -Executable <包exe>`。

## 📚 文档

- [产品说明](docs/PRODUCT.md)：用户行为、状态规则、界面准则与已知边界。
- [开发文档](docs/DEVELOPMENT.md)：工程结构、构建、运行链路及维护约束。
- [状态说明](docs/STATUS.md)：已有验收摘要、当前待验证事项与复验顺序。

MIT License · 欢迎在 [GitHub 仓库](https://github.com/MaxMiksa/Monitor-Focus) 提交 Issue 或 Pull Request。
