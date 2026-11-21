# MyScreen — Screen Controls for Windows

English · [简体中文](README.zh-CN.md)

**Let your screens keep pace with you.**

**[Download for Windows x64 (portable ZIP)][download-zip]**

Adjust your displays on Windows. Press `Win + W` to open the panel, or use the mouse wheel at the edge of your screen without opening it.

**Lightweight tray app: about 19 MB of memory.** This is from one Task Manager reading; actual usage varies. Closing the panel frees its interface while edge scrolling, scheduled transitions, and Focus keep working.

<h2 align="center">Product demo</h2>

https://github.com/user-attachments/assets/46796fce-cb31-4fc6-9784-16fe55aac08f

1 min 37 sec · English narration · [Video credits](docs/media/VIDEO-CREDITS.md)

The screenshots show the app with sample display and weather data.

<h2 align="center">Adjust volume and brightness with the mouse wheel</h2>

Enable edge scrolling under **General**. Scroll at the **top edge** to change that screen’s brightness, or at the **bottom edge** to change system volume. Hold **Alt** (the default modifier) to adjust color temperature at the top edge or the active app’s volume at the bottom, if that app supports separate volume control.

![General settings: appearance and weather on the left, shortcuts and edge scrolling on the right](docs/media/en/edge-controls.jpg)

<h2 align="center">Adjust brightness and color temperature for each display</h2>

Under **Now**, adjust your laptop and external display separately. To make both brighter or dimmer together, turn on **Brightness linking** and move either brightness slider.

![Now tab: individual brightness and color temperature sliders for two displays](docs/media/en/display-controls.jpg)

<h2 align="center">Save and switch between display presets</h2>

Use a brighter setup for daytime work and a warmer one for nighttime reading. Edit each display’s values in **Scenes**, or save your current setup as a new scene. From the home screen, click an icon or use `←` and `→` to switch.

![Scenes tab: morning, midday, dusk, and night presets for two displays](docs/media/en/scenes.jpg)

<h2 align="center">Schedule changes to brightness and color temperature</h2>

In **Transitions**, drag a point to set when a scene starts, or schedule it around sunrise or sunset. Set a duration for brightness and color temperature to change gradually instead of all at once.

![Transitions tab: daily timeline with scene points and curves for brightness and color temperature](docs/media/en/transitions.jpg)

<h2 align="center">Black out a second display when you leave it</h2>

In **Focus**, choose a secondary display and set a delay. A black overlay covers that screen when the pointer leaves; moving it back restores the view without changing the backlight. You can also keep the display visible while watching a full-screen video.

![Focus tab: secondary display selection, delay, and full-screen exception](docs/media/en/focus.jpg)

<h2 align="center">See current weather and rain on the home screen</h2>

The home screen can show scenes as icons only. Press `↓` to check the current temperature and get advice before heading out. If weather effects are enabled, rain appears on the home screen when it’s raining in your selected location.

![Home screen: rainy dusk scene with icon-only controls and an open weather card](docs/media/en/home-weather.jpg)

<h2 align="center">Customize the stars and clouds in each scene</h2>

In **General → Stars and clouds**, adjust how bright the stars are and how much they twinkle, or change the density and speed of the clouds. Each scene remembers its own settings, and these effects only change the home screen.

![Stars and clouds settings: separate controls and a night scene preview](docs/media/en/sky-settings.jpg)

<h2 align="center">Install and launch</h2>

1. [Download the portable ZIP][download-zip] and extract it to a folder you plan to keep.
2. Double-click `MyScreen.exe`. No installer is needed. Press `Win + W` to open the panel and use **General** to enable launch on sign-in.

Requires Windows 10/11 x64 and the [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/#download). External-display brightness requires DDC/CI to be enabled on the monitor. Color temperature control requires a compatible SDR display.

Upgrading from v2.0.0 or earlier? Disable the old app's launch-on-sign-in setting and exit it from the tray before starting MyScreen. Settings from those releases are not imported automatically.

[Product guide (Chinese)](docs/PRODUCT.md) · [Build from source (Chinese)](docs/DEVELOPMENT.md) · [Project status (Chinese)](docs/STATUS.md) · [License](LICENSE)

[download-zip]: https://github.com/MaxMiksa/MyScreen/releases/latest/download/MyScreen-windows-x64.zip
