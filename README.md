# Monitors Focus

简体中文 · [English](README.en.md)

在 Windows 上，让每块屏幕都舒服一点。用 `Win + W` 呼出面板，也可以不打开它，直接在屏幕边缘滚动鼠标。

**轻量后台：常驻进程约 19 MB。** 这是本机任务管理器的一次实测，实际占用因环境而异。关掉面板会释放界面，边缘滚轮、定时渐变和专注仍可继续工作。

<h2 align="center">产品演示</h2>

https://github.com/user-attachments/assets/321a01ba-bdf3-41b0-b84b-7249cf1c68eb

1 分 37 秒 · 英文旁白 · [配乐与素材署名](docs/media/VIDEO-CREDITS.md)

以下为软件界面截图，显示器和天气数据用于演示。

<h2 align="center">通过滚轮快捷调节电脑声音和亮度</h2>

在「通用」开启边缘滚轮。鼠标移到屏幕**顶部**滚动，调这块屏的亮度；移到**底部**滚动，调系统音量。按住默认的 **Alt** 再滚，顶部调屏幕冷暖，底部只调正在出声的前台应用（如果它支持单独调音量）。

![通用：左侧为外观与天气，右侧为窗口快捷键和边缘滚轮](docs/media/edge-controls.jpg)

<h2 align="center">分别调节各屏的亮度和色温</h2>

在「当下」为笔记本和外接屏分别调亮度、色温。想让屏幕一起变亮或变暗，打开「亮度联动」，再拖其中一个亮度滑条就行。

![当下：两块屏幕各有亮度和色温滑条，下方可开启亮度联动](docs/media/display-controls.jpg)

<h2 align="center">保存并快速切换显示场景</h2>

白天办公用偏亮的设置，晚上阅读换成柔和的暖色。在「场景」里为每块屏保存数值，也可以把当前搭配存成新场景。回到首页，点图标或按 `←` / `→` 就能切换。

![场景：在同一页编辑早晨、中午、傍晚和夜间的双屏设置](docs/media/scenes.jpg)

<h2 align="center">按时间自动调节亮度和色温</h2>

在「渐变」里拖动时间点，决定什么时候切到哪个场景，也能按日出、日落安排。设好渐变时长，亮度和色温就会慢慢过渡，不用一下子切换。

![渐变：一天中各个场景的切换时间，以及亮度和色温的过渡曲线](docs/media/transitions.jpg)

<h2 align="center">离开副屏时自动遮黑</h2>

在「专注」里选好副屏和等待时间。鼠标离开后，黑色遮罩会盖住副屏；移回去就恢复，不改变显示器背光。看全屏视频时，也可以让副屏保持亮着。

![专注：选择参与的副屏、变暗等待时间和全屏例外](docs/media/focus.jpg)

<h2 align="center">在首页查看天气和雨景</h2>

首页的场景栏可以设成只显示一排图标。按 `↓` 看当前气温和出门建议；启用天气雨景后，只有当地正在下雨，画面才会跟着下雨。

![首页：傍晚雨景、图标式场景栏和天气卡片](docs/media/home-weather.jpg)

<h2 align="center">按场景调整星星与云彩</h2>

在「通用 → 星星与云彩」，可以分别给四个场景调星星的亮度、闪烁，或云彩的浓淡、飘动速度。这些只改变首页画面。

![星星与云彩：在夜晚预览中分别调整两类效果](docs/media/sky-settings.jpg)

<h2 align="center">安装和启动</h2>

- 需要 Windows 10/11 x64 和 Microsoft Edge WebView2 Runtime。外接屏的亮度调节需要显示器支持并启用 DDC/CI；色温调节适用于兼容的 SDR 屏幕。
- 当前 Go 版从源码构建。执行 `./scripts/build.ps1 -Check -Package`，然后运行生成的 `MonitorsFocus.Go.exe`。首次打开后，可在「通用」开启登录自启。GitHub 上的历史发布包不代表当前版本。
- [产品说明](docs/PRODUCT.md) · [开发与更新](docs/DEVELOPMENT.md) · [验证状态](docs/STATUS.md) · [许可证](LICENSE)
