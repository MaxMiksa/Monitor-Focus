<p align="center"><img src="docs/assets/hero-en.svg" width="100%" alt="Monitors Focus"></p>

<br>

<p align="center">
  <a href="https://github.com/MaxMiksa/Monitors-Focus-Assistant/releases/tag/v2.0.0"><img alt="version" src="https://img.shields.io/badge/version-2.0.0-125cd0?style=flat-square"></a>&nbsp;
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-4a5a70?style=flat-square">&nbsp;
  <img alt="runtime" src="https://img.shields.io/badge/runtime-.NET%2010%20%2B%20WebView2-512BD4?style=flat-square">&nbsp;
  <img alt="license" src="https://img.shields.io/badge/license-MIT-3f8f5a?style=flat-square">&nbsp;
  <a href="README-zh.md"><img alt="中文" src="https://img.shields.io/badge/中文-README-8b9bb0?style=flat-square"></a>
</p>

<p align="center">A resident core controls the displays. The panel opens when you need it.<br>Brightness, color, scenes and schedules for both screens, in one window.</p>

## The problem

Windows exposes one brightness setting for the whole machine. Your external monitor and laptop panel cannot be adjusted independently, and color temperature usually lives in a different on-screen menu on every display.

Monitors Focus brings those controls into one window: independent brightness for each display, calibrated or ratio-linked adjustments, software Gamma warmth for external and laptop displays, and reusable scenes and schedules.

## The panel

<p align="center"><img src="docs/assets/panel-controls.png" width="620" alt="Control panel"></p>

<p align="center"><sub>Real hardware: AOC U27G4 over DDC/CI and the laptop panel over WMI. Values are targets; hardware failures are reported separately.</sub></p>

## Features

| Capability | What it does |
| --- | --- |
| Per-display brightness | Writes the actual backlight for each display; DDC/CI for external screens, WMI for the internal panel |
| Brightness linking | Uses a measured piecewise curve in either direction for calibrated pairs, provisionally at every temperature, with the laptop capped at 100%; other displays retain ratio linking |
| Per-display temperature | Uses software Gamma on compatible SDR external and laptop displays, with independent warmth and native color restoration; Kelvin is approximate and warmth is limited by the system range |
| Laptop warmth compensation | Uses four visually matched calibration points to compensate the laptop backlight as it warms; external displays are excluded and backlight limits are reported |
| Daily schedule | Switches scenes at time nodes and eases between targets; continuous across midnight, with manual control retained until the next node |
| Scenes | Stores per-display brightness, color and focus rules for quick switching |
| Focus | Shows an overlay after the pointer leaves the selected secondary display, with pause and full-screen exceptions |
| Edge scrolling | Top edge for brightness, bottom edge for system volume, 2% per notch; independent switches default off, brightness follows linking, and native Windows indicators show feedback (brightness uses the internal panel value) |
| Alt + edge scrolling | Top edge adjusts temperature by 100 K; bottom edge adjusts foreground app volume by 2% with one shared percentage, preserving mute; lightweight numeric/progress feedback; choose Alt, Ctrl or Shift in General settings and save |
| Languages | Simplified Chinese, English and system default, previewed immediately and saved for the panel and tray |
| Launch on startup | Keeps one startup entry pointing to the self-contained core |
| On-demand panel | Closing the panel exits the UI while schedules, focus and enabled edge scrolling keep running |

## Quick start

1. Download [MonitorsFocus-v2.0.0-win-x64.zip](https://github.com/MaxMiksa/Monitors-Focus-Assistant/releases/download/v2.0.0/MonitorsFocus-v2.0.0-win-x64.zip) and extract it.
2. Run `desktop/MonitorsFocus.WebHost.exe`; keep `core/` beside `desktop/`.
3. Enable launch on startup in Settings. The entry points to `core/MonitorsFocus.exe --center --background`.

The package bundles the .NET runtime. You only need Microsoft Edge WebView2 Runtime, which ships with most Windows 11 installations.

The GitHub v2.0.0 release is the public baseline. This repository contains later improvements that have not yet been published remotely.

## How it runs

<p align="center"><img src="docs/assets/architecture-en.svg" width="100%" alt="Runtime structure"></p>

- Only the C# core holds device handles; the panel never touches hardware directly.
- The WebView2 bridge exposes only allowlisted commands and validates message origins.
- Commands run serially per device; a wait timeout does not cancel the underlying call.
- Closing the panel releases WebView2 while schedules, focus and enabled edge scrolling keep running.

## What is verified

| Item | Current status |
| --- | --- |
| Web type check, production build and Oxlint | Passed on 2026-11-12, 0 warnings and 0 errors |
| Solution Release build | Passed on 2026-11-12, 0 warnings and 0 errors |
| Automated checks | 59 pass on 2026-11-12, including immediate preview and asynchronous reconciliation, configurable modifier isolation, process ownership, temperature linking, native indicators and existing checks |
| Edge scrolling | User confirmed basic adjustment; native indicators were captured. Two divergent fixture sessions converged to 50% while mute, unrelated sessions and master volume stayed unchanged. modifier feedback reuse, auto-hide and drawing-resource checks passed; short-lived application audio reuse passed individual-notch latency, external mixer change and idle-release checks; real gesture feel, browser audio processes and output changes await verification |
| Real dual-display brightness reads | Verified |
| External hardware color write and restore | Verified on AOC U27G4 |
| Dual-display software color | AOC and BOE ramp writes, isolation and restoration pass; the user confirmed warmth on both displays and normal restoration on the laptop panel |
| Keep awake for full-screen or maximized windows | Native window detection passes; real-hardware integration is pending |
| Ratio binding, sleep recovery, mixed DPI and long runs | Pending |

The local runtime now uses the AOC/BOE brightness curve provisionally at every temperature, with additional warmth compensation disabled. It also includes dual-display Gamma adjustment and the latest simplified scene editor, whose interactions have not received a new acceptance pass. The GitHub download is unchanged. See [acceptance](docs/ACCEPTANCE.md) for the full boundary.

The current local build is `publish/control-center-20261112-194021/`. It was restarted normally on 2026-11-12 with an updated startup entry; both enabled switches and the current display settings were preserved. Enhanced numeric/progress feedback now updates immediately while actual adjustment runs asynchronously and reconciles the preview. An unknown initial app volume displays “…” until its first actual reading; failures dismiss the preview and report an error. Feedback reuses one lazy window inside the core with no additional resident process. New configurations default both switches off; enable them individually in Settings → General and save. Previous packages remain available; no remote release was published.

## Documentation

| Document | Coverage |
| --- | --- |
| [Documentation index](docs/INDEX.md) | Main documents, archived records and media |
| [Product](docs/PRODUCT.md) | Scope, user behavior and state rules |
| [Development](docs/DEVELOPMENT.md) | Architecture, build, configuration, hardware and packaging |
| [Design](docs/DESIGN.md) | Layout, tokens, components and interaction rules |
| [Acceptance](docs/ACCEPTANCE.md) | Current verification and pending hardware work |

## Upgrading from v1.0.0

Quit the old tray process before starting the new core, otherwise its single-instance lock will keep the new process from opening. The first launch backs up `settings.json` as `settings.json.pre-center.bak` and inherits startup, focus delay and language preferences.

The new focus mode only draws an overlay and no longer lowers hardware brightness. The legacy `FocusBrightness` value is ignored and removed on the next save. Launching without `--center` still starts the v1 pointer-follow overlay and retains its original dimming behavior for compatibility.

## Development

```powershell
./scripts/build.ps1
./src/MonitorsFocus.WebHost/bin/Release/net10.0-windows/MonitorsFocus.WebHost.exe
```

Requires the .NET 10 SDK, Node.js 24.11.1 (24 LTS), pnpm 12.16.1 and WebView2 Runtime. The build restores Web dependencies with `pnpm install --frozen-lockfile`; `src/MonitorsFocus.Web/pnpm-lock.yaml` is the active JavaScript lock. If pnpm is outside PATH, pass `-Pnpm D:\Apps\pnpm\12.16.1\pnpm.exe` to the build script. See [development](docs/DEVELOPMENT.md) for browser preview, the desktop host and packaging.

## License and contact

MIT License. Issues and pull requests are welcome.

Zheyuan (Max) Kong · Carnegie Mellon University

[kongzheyuan@outlook.com](mailto:kongzheyuan@outlook.com) · [zheyuank@tepper.cmu.edu](mailto:zheyuank@tepper.cmu.edu)

The source now checks active warmth about every three seconds and reapplies it after a reset to its saved baseline. Hardware controls require the physical console session and a verified display identity. The local core has been updated; a real AOC Gamma reset recovered in about 0.8 seconds. Background capture isolation still needs an on-device check.
