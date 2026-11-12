# Project rules

Windows display controller: brightness/color, scenes, schedules, focus, optional edge scrolling. Stack: C#/.NET 10, React/TypeScript, WebView2.

Docs: [中文](README-zh.md), [English](README.md), [Index](docs/INDEX.md), [Product](docs/PRODUCT.md), [Development](docs/DEVELOPMENT.md), [Design](docs/DESIGN.md), [Acceptance](docs/ACCEPTANCE.md).

- Reply concisely in Chinese; clarify material ambiguity. Keep changes focused and follow existing conventions/dependencies.
- Maintain affected docs before/after implementation; keep this file under 500 tokens. Progress belongs in Acceptance.
- Substantial UI changes need an approved visual; small changes reuse components. Run proportionate checks; clean temporary files, retain user data/caches. No automatic commit/push/release. `Files/` is historical.
- `src/MonitorsFocus` owns hardware/legacy entry; `--center --background` selects the core. `.Core` holds protocol/computation; `.Web` React; `.WebHost` on-demand UI. No production HTTP backend or runtime Node/Vite. Bridge: allowlisted commands, validated origins, no general execution.
- Serialize hardware calls; timeout is not cancellation. Drain before releasing handles; report failures honestly.
- Write/restore only identified physical-console displays; reject other sessions. Background RDP capture isolation requires separate acceptance.
- Gamma: preserve/verify originals per display; reject HDR/uncertain mapping; preserve newer external colors.
- Compensation: calibrated internal display only, separate user/backlight targets, withdraw on restore/failure/exit. Device-pair brightness curves stay separate; personal calibration is not a default.
- Revision conflicts retain drafts. Back up migration; failed reads/migration must not change startup.
- Disable/exit unhooks edge input; callbacks do no hardware work. Modifier feedback (Alt default) reuses one lazy native window; app sessions share one mixer percentage. Ordinary edges use native OSD; brightness shows the internal panel.
- One startup entry: self-contained `core/MonitorsFocus.exe --center --background`. Build Web before C# with `scripts/build.ps1`. SDK, Node/pnpm versions, local paths and commands: Development.
