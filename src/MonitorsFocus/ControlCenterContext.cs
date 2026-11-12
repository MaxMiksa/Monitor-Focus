using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json;
using Microsoft.Win32;
using MonitorsFocus.Brightness;
using MonitorsFocus.Core;
using MonitorsFocus.Monitoring;
using MonitorsFocus.Overlay;
using MonitorsFocus.Settings;
using Timer = System.Windows.Forms.Timer;

namespace MonitorsFocus;

internal sealed class ControlCenterContext : ApplicationContext
{
    private sealed class Display
    {
        public required MonitorInfo Monitor;
        public required string Id;
        public required string Name;
        public ControlledDisplay? Controller;
        public int Brightness;
        public int? Kelvin;
        public string? Error;
        public bool IsInternal;
        public string? CompensationWarning;
        public int? BacklightTarget;
        public OverlayForm? Overlay;
        public readonly FocusDimming Focus = new();
        public (int, int, int?)? LastRequest;
        public long NextColorCheck;
        public Task LastApply = Task.CompletedTask;
    }

    private readonly SynchronizationContext _ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
    private readonly CancellationTokenSource _lifetime = new();
    private readonly MonitorManager _monitors = new();
    private readonly ControlSettingsStore _store = new();
    private readonly List<Display> _displays = new();
    private readonly Dictionary<string, int?> _retainedKelvin = new();
    private readonly NotifyIcon _tray;
    private readonly Timer _timer = new() { Interval = 50 };
    private readonly SemaphoreSlim _scanGate = new(1);
    private ControlSettings _settings;
    private bool _paused;
    private bool _scanning;
    private bool _closing;
    private DateTime? _manualUntil;
    private DateTime? _activePlanAt;
    private Dictionary<string, DisplayTarget>? _transitionFrom;
    private Func<DateTime> _clock = () => DateTime.Now;
    private long _nextPlanAt;
    private long _nextFullscreenAt;
    private HashSet<string> _fullscreenDisplays = new();
    private Scene? _sourceScene;
    private bool _sourceIsPlan;
    private string T(string key) => Localization.Text(key, _settings.Language);
    private string? _error;
    private string? _planError;

    public ControlCenterContext(bool openPanel)
    {
        try
        {
            _settings = _store.Load();
            // 配置读取或迁移失败时，不用默认值覆盖已有自启选择。
            StartupManager.Ensure(_settings.LaunchOnStartup);
        }
        catch (Exception ex) { _settings = new(); _error = $"原配置未覆盖：{ex.Message}"; }
        var menu = new ContextMenuStrip();
        menu.Items.Add(T("打开控制面板"), null, (_, _) => OpenPanel());
        menu.Items.Add(T("暂停 / 恢复专注"), null, (_, _) => { _paused = !_paused; Tick(); });
        menu.Items.Add(T("恢复原色"), null, (_, _) => { RestoreColor(); HoldManual(); Tick(); });
        menu.Items.Add(T("退出"), null, (_, _) => ExitThread());
        _tray = new NotifyIcon { Text = "Monitors Focus", Icon = AppIcons.Tray(), Visible = true, ContextMenuStrip = menu };
        menu.Opening += (_, _) =>
        {
            var keys = new[] { "打开控制面板", "暂停 / 恢复专注", "恢复原色", "退出" };
            for (var i = 0; i < keys.Length; i++) menu.Items[i].Text = T(keys[i]);
        };
        _tray.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) OpenPanel(); };
        _timer.Tick += (_, _) => Tick();
        _timer.Start();
        _monitors.MonitorsChanged += MonitorsChanged;
        SystemEvents.PowerModeChanged += PowerChanged;
        SystemEvents.UserPreferenceChanged += ThemeChanged;
        _ = ServeAsync();
        _ = ScanAsync();
        if (openPanel) OpenPanel();
    }

    private void MonitorsChanged(object? sender, EventArgs e) => _ui.Post(_ => { if (!_closing) _ = ScanAsync(); }, null);
    private void ThemeChanged(object sender, UserPreferenceChangedEventArgs e)
    {
        if (e.Category == UserPreferenceCategory.General) _ui.Post(_ => { if (!_closing) { var old = _tray.Icon; _tray.Icon = AppIcons.Tray(); old?.Dispose(); } }, null);
    }
    private void PowerChanged(object sender, PowerModeChangedEventArgs e)
    {
        if (e.Mode == PowerModes.Resume) _ui.Post(_ => { if (!_closing) _ = ScanAsync(); }, null);
    }

    private async Task ScanAsync()
    {
        if (_closing) return;
        _scanning = true;
        await _scanGate.WaitAsync();
        try
        {
            if (_closing) return;
            _scanning = true;
            foreach (var display in _displays) _retainedKelvin[display.Id] = display.Kelvin;
            await CloseDisplaysAsync();
            var monitors = _monitors.Monitors.ToArray();
            foreach (var monitor in monitors)
            {
                var result = await Task.Run(() =>
                {
                    var identity = DisplayIdentity.FindInstance(monitor.Id);
                    IBrightnessDevice? device = null;
                    ControlledDisplay? controller = null;
                    ITemperatureDevice? color = null;
                    string? error = null;
                    try
                    {
                        for (var attempt = 0; attempt < 2 && device == null; attempt++)
                        {
                            device = DdcBrightnessDevice.Open(monitor);
                            if (device == null && attempt == 0) Thread.Sleep(200);
                        }
                        device ??= WmiBrightnessController.Open(identity, monitor.Id);
                        if (device != null)
                        {
                            color = GammaColorDevice.Open(monitor.Id, out error);
                            controller = new ControlledDisplay(device, color);
                        }
                    }
                    catch (Exception ex) { color?.Dispose(); device?.Dispose(); error = ex.Message; }
                    return new Display
                    {
                        Monitor = monitor, Id = identity ?? monitor.Id,
                        Name = identity?.Contains("AOC", StringComparison.OrdinalIgnoreCase) == true ? "AOC U27G4" :
                            identity?.Contains("BOE", StringComparison.OrdinalIgnoreCase) == true ? "笔记本屏幕" : monitor.Id,
                        Controller = controller, Brightness = controller?.InitialBrightness ?? 0,
                        IsInternal = DisplayColorMode.IsInternal(monitor.Id),
                        Error = error ?? (controller == null ? "硬件亮度不可用" : null)
                    };
                });
                result.Kelvin = _retainedKelvin.GetValueOrDefault(result.Id);
                result.Overlay = new OverlayForm(monitor.Bounds, 100);
                _displays.Add(result);
            }
            if (_settings.Scenes.Count == 0)
            {
                foreach (var (name, factor, kelvin) in new[] { ("日常", 1.0, 6500), ("夜间", 0.5, 3200), ("专注", 0.7, 4500) })
                    _settings.Scenes.Add(new Scene { Name = name, DefaultName = name, Behavior = SceneBehavior.Capture(_settings), Targets = _displays.ToDictionary(d => d.Id,
                        d => new DisplayTarget((int)Math.Round(d.Brightness * factor), d.Controller?.SupportsColor == true ? kelvin : null)) });
            }
            _nextPlanAt = 0;
            _nextFullscreenAt = 0;
            _fullscreenDisplays.Clear();
        }
        catch (Exception ex) { _error = $"检测失败：{ex.Message}"; }
        finally { _scanning = false; _scanGate.Release(); }
    }

    private void ApplyBrightness(Display display, int value)
    {
        var values = _settings.Linked ? LinkedBrightness(display.Id, value)
            : new Dictionary<string, int> { [display.Id] = value };
        foreach (var d in _displays)
            if (values.TryGetValue(d.Id, out var brightness)) { d.Brightness = brightness; d.Focus.Reset(); }
        HoldManual();
    }

    private void Tick()
    {
        if (_closing || _scanning) return;
        var now = Environment.TickCount64;
        if (now >= _nextPlanAt)
        {
            _nextPlanAt = now + 1000;
            var localNow = _clock();
            var plan = DailyPlan.Evaluate(_settings, localNow);
            if (plan is { } activePlan && (!_manualUntil.HasValue || localNow >= _manualUntil))
            {
                try
                {
                    if (_activePlanAt != activePlan.StartsAt)
                    {
                        // A live hand-off starts at the user's current levels. After sleep or
                        // startup, compute the canonical point instead of replaying a missed fade.
                        _transitionFrom = _manualUntil == activePlan.StartsAt &&
                            localNow - activePlan.StartsAt <= TimeSpan.FromSeconds(2)
                            ? _displays.ToDictionary(d => d.Id, d => new DisplayTarget(d.Brightness, d.Kelvin)) : null;
                        ApplySceneBehavior(activePlan.Scene);
                        _activePlanAt = activePlan.StartsAt;
                    }
                    _manualUntil = null;
                    foreach (var d in _displays)
                        if (activePlan.TryGetTarget(d.Id, out var brightness, out var kelvin, _transitionFrom))
                        {
                            d.Brightness = brightness;
                            d.Kelvin = d.Controller?.SupportsColor == true ? kelvin : null;
                        }
                    ApplyCalibratedLink(activePlan.Scene.Targets);
                    _sourceScene = activePlan.Scene;
                    _sourceIsPlan = true;
                    _planError = null;
                }
                catch (Exception ex) { _planError = $"时间计划未应用：{ex.Message}"; }
            }
        }
        var cursor = _settings.FocusEnabled && !_paused ? Cursor.Position : Point.Empty;
        if (_settings.FocusEnabled && !_paused && _settings.KeepSecondaryAwakeOnFullscreen)
        {
            if (now >= _nextFullscreenAt)
            {
                _fullscreenDisplays = FullscreenWindowDetector.FindDisplays(_displays.Select(d => d.Monitor).ToArray());
                _nextFullscreenAt = now + 250;
            }
        }
        else { _fullscreenDisplays.Clear(); _nextFullscreenAt = 0; }
        foreach (var d in _displays)
        {
            var dim = d.Focus.Update(_settings, _paused, d.Monitor.IsPrimary, d.Monitor.Bounds.Contains(cursor),
                _fullscreenDisplays.Contains(d.Monitor.Id), now, d.Id);
            if (dim) d.Overlay?.ShowOverlay(); else d.Overlay?.HideOverlay();
            var compensation = d.IsInternal && d.Controller?.SupportsColor == true &&
                _settings.TemperatureBrightnessCalibrations.TryGetValue(d.Id, out var calibration)
                ? calibration.Evaluate(d.Brightness, d.Kelvin) : new CompensatedBrightness(d.Brightness, false);
            d.CompensationWarning = compensation.Limited ? "内屏背光已达上限，当前色温下无法完全补偿亮度" : null;
            d.BacklightTarget = compensation.Value;
            var target = (d.Brightness, compensation.Value, d.Kelvin);
            // Session initialization can reset Gamma without changing display topology.
            // Recheck active warmth through the serialized worker, not on the UI thread.
            if (d.LastRequest == target && (d.Kelvin is not (< 6500) ||
                d.Controller?.SupportsColor != true || now < d.NextColorCheck)) continue;
            d.NextColorCheck = now + 3000;
            d.LastRequest = target;
            if (d.Controller != null) d.LastApply = d.Controller.ApplyAsync(d.Brightness, compensation.Value, d.Kelvin);
        }
        _timer.Interval = _settings.FocusEnabled && !_paused ? 50 : 1000;
    }

    private void ApplyTargets(Dictionary<string, DisplayTarget> targets)
    {
        foreach (var d in _displays)
            if (targets.TryGetValue(d.Id, out var target))
            {
                d.Brightness = target.Brightness;
                d.Kelvin = d.Controller?.SupportsColor == true ? QuantizeKelvin(target.Kelvin) : null;
            }
        ApplyCalibratedLink(targets);
    }

    private Dictionary<string, int> LinkedBrightness(string anchor, int value)
    {
        var available = _displays.Where(d => d.Controller != null).Select(d => d.Id).ToArray();
        var calibration = _settings.BrightnessLinkCalibration;
        if (calibration != null && (anchor == calibration.SourceId || anchor == calibration.TargetId))
            return calibration.MatchesPair(available)
                ? calibration.Calculate(anchor, value, _displays.Single(d => d.Id == calibration.SourceId).Brightness)
                : new() { [anchor] = value };
        return RatioBinding.CalculateAvailable(_settings.LinkWeights,
            available.Where(id => calibration == null || (id != calibration.SourceId && id != calibration.TargetId)), anchor, value);
    }

    private void ApplyCalibratedLink(IReadOnlyDictionary<string, DisplayTarget>? targets = null)
    {
        var calibration = _settings.BrightnessLinkCalibration;
        if (!_settings.Linked || calibration == null ||
            !calibration.MatchesPair(_displays.Where(d => d.Controller != null).Select(d => d.Id))) return;
        var anchor = targets == null || targets.ContainsKey(calibration.SourceId) ? calibration.SourceId :
            targets.ContainsKey(calibration.TargetId) ? calibration.TargetId : null;
        if (anchor == null) return;
        var values = LinkedBrightness(anchor, _displays.Single(d => d.Id == anchor).Brightness);
        foreach (var d in _displays)
            if (values.TryGetValue(d.Id, out var brightness)) d.Brightness = brightness;
    }

    private static int? QuantizeKelvin(int? value) => value.HasValue ? (int)Math.Round(value.Value / 100.0) * 100 : null;

    private void ApplySceneBehavior(Scene scene)
    {
        var settings = CloneSettings();
        if (scene.Behavior?.ApplyTo(settings) == true)
        {
            _store.Save(settings);
            _settings = settings;
        }
        foreach (var display in _displays) display.Focus.Reset();
        _nextFullscreenAt = 0;
    }

    private void RestoreColor()
    {
        _retainedKelvin.Clear();
        foreach (var display in _displays) display.Kelvin = null;
    }

    private void HoldManual()
    {
        _manualUntil = DailyPlan.Evaluate(_settings, _clock())?.NextAt;
        _planError = null;
        _sourceScene = null;
        _sourceIsPlan = false;
    }

    private ControlSnapshot Handle(ControlRequest request)
    {
        try
        {
            if (_closing) throw new InvalidOperationException("正在退出。");
            if (_scanning && request.Action is not "snapshot") throw new InvalidOperationException("正在检测显示器，请稍候。");
            switch (request.Action)
            {
                case "brightness":
                    var display = _displays.Single(d => d.Id == request.Id);
                    if (display.Controller == null) throw new InvalidOperationException("此显示器不支持亮度调节。");
                    var value = Math.Clamp(request.Value ?? display.Brightness, 0, 100);
                    ApplyBrightness(display, value);
                    break;
                case "temperature":
                    var colorDisplays = request.Id == null
                        ? _displays.Where(d => d.Controller?.SupportsColor == true).ToArray()
                        : new[] { _displays.Single(d => d.Id == request.Id) };
                    if (colorDisplays.Any(d => d.Controller?.SupportsColor != true))
                        throw new InvalidOperationException("色温暂不可用，可在设置中重新检测");
                    foreach (var d in colorDisplays)
                        d.Kelvin = QuantizeKelvin(Math.Clamp(request.Value ?? 6500, 2700, 6500));
                    HoldManual();
                    break;
                case "restore-color":
                    RestoreColor();
                    HoldManual();
                    break;
                case "link":
                    var enabled = request.Value == 1;
                    var weights = _displays.Where(d => d.Controller != null).ToDictionary(d => d.Id, d => (double)d.Brightness);
                    var calibrated = _settings.BrightnessLinkCalibration?.MatchesPair(weights.Keys) == true;
                    if (enabled && (weights.Count < 2 || (!calibrated && weights.Values.Any(x => x <= 0))))
                        throw new ArgumentException("请先为两块可调屏幕设置非零亮度。");
                    var linkedSettings = CloneSettings();
                    linkedSettings.Linked = enabled;
                    if (enabled) linkedSettings.LinkWeights = calibrated
                        ? weights.ToDictionary(p => p.Key, p => Math.Max(1, p.Value)) : weights;
                    _store.Save(linkedSettings);
                    _settings = linkedSettings;
                    ApplyCalibratedLink();
                    break;
                case "scene":
                    var scene = _settings.Scenes.Single(s => s.Id == request.Id);
                    ApplySceneBehavior(scene);
                    ApplyTargets(scene.Targets);
                    HoldManual();
                    _sourceScene = scene;
                    break;
                case "pause": _paused = !_paused; break;
                case "resume-plan": _manualUntil = null; _activePlanAt = null; _transitionFrom = null; _nextPlanAt = 0; break;
                case "rescan": _ = ScanAsync(); break;
                case "save":
                    var settings = request.Settings ?? throw new ArgumentException("缺少设置。");
                    if (settings.Revision != _settings.Revision) throw new InvalidOperationException("设置已在其他操作中更新。请重新载入设置后再保存。");
                    DailyPlan.Validate(settings);
                    StartupManager.Apply(settings.LaunchOnStartup, StartupManager.CenterArguments, reportFailure: true);
                    try { _store.Save(settings); }
                    catch
                    {
                        StartupManager.Apply(_settings.LaunchOnStartup, StartupManager.CenterArguments);
                        throw;
                    }
                    ApplySavedSettings(settings);
                    break;
                case "snapshot": break;
                case "exit": _ui.Post(_ => ExitThread(), null); break;
                default: throw new ArgumentException("未知操作。");
            }
            Tick();
            return Snapshot();
        }
        catch (Exception ex) { return Snapshot(ex.Message); }
    }

    private ControlSettings CloneSettings() => JsonSerializer.Deserialize<ControlSettings>(JsonSerializer.Serialize(_settings))!;

    private void ApplySavedSettings(ControlSettings settings)
    {
        var planChanged = !DailyPlan.HasSameDefinition(_settings, settings);
        var bindingChanged = settings.Linked != _settings.Linked ||
            JsonSerializer.Serialize(settings.BrightnessLinkCalibration) != JsonSerializer.Serialize(_settings.BrightnessLinkCalibration);
        _settings = settings;
        if (bindingChanged) ApplyCalibratedLink();
        if (planChanged)
        {
            _activePlanAt = null;
            _transitionFrom = null;
            _manualUntil = null;
            _sourceScene = null;
        }
        else if (_sourceScene != null)
            _sourceScene = _settings.Scenes.FirstOrDefault(s => s.Id == _sourceScene.Id);
        _planError = null;
        _nextPlanAt = 0;
        _nextFullscreenAt = 0;
    }

    private ControlSnapshot Snapshot(string? error = null) => new(_displays.Select(d => new DisplayState(d.Id, d.Name == "笔记本屏幕" ? T(d.Name) : d.Name,
        d.Brightness, d.Controller != null, d.Controller?.SupportsColor == true, d.Kelvin,
        Localization.Message(d.Controller?.Error ?? d.Error, _settings.Language), d.Monitor.IsPrimary, d.BacklightTarget)).ToList(), CloneSettings(), _paused,
        _scanning ? T("正在检测显示器…") : _sourceScene != null
            ? Localization.Format(_sourceIsPlan ? "时间计划 · {0}" : "场景 · {0}", _settings.Language, Localization.SceneName(_sourceScene, _settings.Language))
            : _manualUntil.HasValue ? Localization.Format("手动 · 保持至 {0}", _settings.Language, _manualUntil.Value.ToString("HH:mm"))
            : T("手动调节"), Localization.Message(error, _settings.Language), Localization.Message(_planError ?? _error ??
                _displays.Select(d => d.CompensationWarning).FirstOrDefault(w => w != null), _settings.Language), Localization.Resolve("system"));

    private async Task ServeAsync()
    {
        while (!_lifetime.IsCancellationRequested)
        {
            try
            {
                using var pipe = new NamedPipeServerStream(ControlProtocol.PipeName, PipeDirection.InOut, 1,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync(_lifetime.Token).ConfigureAwait(false);
                PhysicalDisplayScope.EnsureClient(pipe.SafePipeHandle.DangerousGetHandle());
                using var reader = new StreamReader(pipe, leaveOpen: true);
                using var writer = new StreamWriter(pipe, leaveOpen: true) { AutoFlush = true };
                var line = await reader.ReadLineAsync(_lifetime.Token).ConfigureAwait(false);
                if (line == null || line.Length > 65536) continue;
                var request = JsonSerializer.Deserialize<ControlRequest>(line) ?? new ControlRequest("snapshot");
                var completion = new TaskCompletionSource<ControlSnapshot>(TaskCreationOptions.RunContinuationsAsynchronously);
                _ui.Post(_ => completion.TrySetResult(Handle(request)), null);
                var snapshot = await completion.Task.WaitAsync(_lifetime.Token).ConfigureAwait(false);
                await writer.WriteLineAsync(JsonSerializer.Serialize(snapshot)).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { LogSink.Info($"Control connection: {ex.Message}"); }
        }
    }

    private void OpenPanel()
    {
        var desktop = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "desktop", "MonitorsFocus.WebHost.exe"));
        if (!File.Exists(desktop))
        {
            var root = new DirectoryInfo(AppContext.BaseDirectory);
            while (root != null && !File.Exists(Path.Combine(root.FullName, "MonitorsFocus.sln"))) root = root.Parent;
            if (root != null) desktop = Path.Combine(root.FullName, "src", "MonitorsFocus.WebHost", "bin", "Release",
                "net10.0-windows", "MonitorsFocus.WebHost.exe");
        }
        if (File.Exists(desktop)) Process.Start(new ProcessStartInfo(desktop) { UseShellExecute = true });
        else MessageBox.Show(T("请先构建控制面板，或使用完整发布包。"), "Monitors Focus");
    }

    private async Task CloseDisplaysAsync()
    {
        var displays = _displays.ToArray();
        _displays.Clear();
        foreach (var d in displays) d.Overlay?.Dispose();
        await Task.WhenAll(displays.Where(d => d.Controller != null).Select(d => d.Controller!.CloseAsync()));
    }

    protected override async void ExitThreadCore()
    {
        if (_closing) return;
        _closing = true;
        _lifetime.Cancel();
        _timer.Dispose();
        SystemEvents.PowerModeChanged -= PowerChanged;
        SystemEvents.UserPreferenceChanged -= ThemeChanged;
        _monitors.MonitorsChanged -= MonitorsChanged;
        _monitors.Dispose();
        _tray.Text = T("Monitors Focus - 正在恢复显示器");
        await _scanGate.WaitAsync();
        try { await CloseDisplaysAsync(); }
        catch (Exception ex) { MessageBox.Show(Localization.Format("显示器恢复失败：{0}", _settings.Language, Localization.Message(ex.Message, _settings.Language)), "Monitors Focus"); }
        finally { _scanGate.Release(); _tray.Dispose(); base.ExitThreadCore(); }
    }
}
