# Project rules

Windows display controller: brightness/color, scenes, schedules, focus and edge scrolling. Go/Wails 3, React/TypeScript, WebView2. One workspace; sole local branch: main.

Docs: README.md (English default), README.zh-CN.md (Chinese); docs/PRODUCT.md (behavior/design), DEVELOPMENT.md (build/architecture), STATUS.md (verified/open items).

- Reply concisely in Chinese. Update docs before/after; retain current guidance only. Keep this file under 500 tokens. After each completed stage: minimal checks, deploy production, commit and push. Recycle obsolete/merged worktrees; retain five newest local packages after deployment, protecting running/startup paths.
- Go sources at root; internal/{win32,audio,desktop,domain,startup}; frontend/ for UI; scripts/build.ps1 is the build entry. build/ holds generated output and the active package: check running/self-start paths before cleanup. No legacy stack or separate lab.
- Substantial UI changes require approved visuals; reuse components. Approved 16:9 cinematic stage: four clean full-page original images without baked text or UI, material-glass controls (no backdrop blur), compact round scene capsule morphing into a wide glass settings overlay; five compact bottom tabs (Now first), right-aligned undo/redo, autosave, no top chrome/collapse arrow. Noto Sans/SC bundled fonts. Arrow/WASD navigation; Esc collapses then closes to tray. Keep the window 16:9 during initial sizing and resize. Test proportionately; recycle obsolete files. Preserve live settings, calibration and shared caches.
- Validate bridge origins/actions; no general execution or production Node/business HTTP backend.
- Serialize hardware; timeout is not cancellation. Drain before release and report errors. Write/restore only identified physical-console devices; RDP capture isolation remains unverified.
- Gamma: preserve verified originals and newer external colors; reject HDR/uncertain identity. Compensation only for calibrated internal panels; separate normal/backlight targets and pair curves. Withdraw compensation before color restore/failure/exit. Never default personal calibration.
- Revision conflicts preserve drafts. Back up migrations; failed read/migration/init must not change startup.
- Disable/exit unhooks input; callbacks do no hardware work. Reuse lazy modifier feedback. Missing app audio uses throttled tray notices, never fabricated 0%. Ordinary edges use native OSD; brightness reports the internal panel.
- Unique startup: MyScreen.exe --mode native --hardware --production --background. Exit retains latest normal brightness and restores color.
- docs/STATUS.md: feature status, future work (requires explicit user authorization), and only user-confirmed permanent exclusions. Keep three sections concise; no progress log. Tool paths and Go memory-overlay maintenance: docs/DEVELOPMENT.md.
