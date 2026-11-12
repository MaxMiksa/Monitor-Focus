using System.Collections;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Windows.Forms;
using MonitorsFocus;
using MonitorsFocus.Brightness;
using MonitorsFocus.Core;
using MonitorsFocus.Monitoring;
using MonitorsFocus.Settings;

internal static class ControlCenterChecks
{
    private static ControlSettings Settings() => new()
    {
        Language = "en", ScheduleEnabled = true, KeepSecondaryAwakeOnFullscreen = false,
        Scenes =
        [
            new() { Id = "day", Name = "Day", Behavior = new() { FocusEnabled = true }, Targets = new() { ["a"] = new(90, null) } },
            new() { Id = "night", Name = "Night", Behavior = new() { FocusEnabled = true }, Targets = new() { ["a"] = new(10, 2700) } }
        ],
        Schedule = [new(8 * 60, "day", 0), new(20 * 60, "night", 60)]
    };

    public static async Task EdgeBrightnessAsync()
    {
        var settings = Settings();
        settings.TopEdgeBrightnessEnabled = true;
        await using var app = new Fixture(settings, new(2026, 11, 1, 19, 0, 0));
        app.Tick();
        app.EdgeBrightness("a", 1);
        app.Tick();
        Equal(92, app.Snapshot().Displays[0].Brightness);
        Equal(60, app.Snapshot().Displays[1].Brightness);
        Check(app.Snapshot().Source.StartsWith("Manual"));
        var saved = app.Snapshot().Settings;
        saved.Linked = true;
        saved.LinkWeights = new() { ["a"] = 60, ["b"] = 30 };
        app.Save(saved);
        app.EdgeBrightness("a", -1);
        Equal(90, app.Snapshot().Displays[0].Brightness);
        Equal(45, app.Snapshot().Displays[1].Brightness);
        app.EdgeBrightness("b", 100);
        Equal(100, app.Snapshot().Displays[0].Brightness);
        Equal(50, app.Snapshot().Displays[1].Brightness);
        app.EdgeBrightness("b", -100);
        Equal(0, app.Snapshot().Displays[0].Brightness);
        Equal(0, app.Snapshot().Displays[1].Brightness);
        saved = app.Snapshot().Settings;
        saved.TopEdgeBrightnessEnabled = false;
        app.Save(saved);
        app.EdgeBrightness("a", 1);
        Equal(0, app.Snapshot().Displays[0].Brightness);
        app.EdgeBrightness("offline", 1);
        Equal(0, app.Snapshot().Displays[0].Brightness);
    }

    public static async Task EdgeTemperatureAsync()
    {
        var settings = Settings();
        settings.TopEdgeBrightnessEnabled = true;
        await using var app = new Fixture(settings, new(2026, 11, 1, 19, 0, 0));
        app.Tick();
        app.EdgeTemperature("a", -1);
        Equal(6400, app.Snapshot().Displays[0].Kelvin);
        Equal<int?>(null, app.Snapshot().Displays[1].Kelvin);
        Equal(90, app.Snapshot().Displays[0].Brightness);
        Check(app.Snapshot().Source.StartsWith("Manual"));
        var saved = app.Snapshot().Settings;
        saved.Linked = true;
        saved.LinkWeights = new() { ["a"] = 90, ["b"] = 60 };
        app.Save(saved);
        app.EdgeTemperature("a", -100);
        Equal(2700, app.Snapshot().Displays[0].Kelvin);
        Equal(2700, app.Snapshot().Displays[1].Kelvin);
        app.EdgeTemperature("b", 100);
        Equal(6500, app.Snapshot().Displays[0].Kelvin);
        Equal(6500, app.Snapshot().Displays[1].Kelvin);
        saved = app.Snapshot().Settings;
        saved.TopEdgeBrightnessEnabled = false;
        app.Save(saved);
        app.EdgeTemperature("a", -1);
        Equal(6500, app.Snapshot().Displays[0].Kelvin);
    }

    public static async Task ManualHandoffAsync()
    {
        await using var app = new Fixture(Settings(), new(2026, 11, 1, 19, 59, 59));
        app.Tick();
        app.Send(new("temperature", Value: 4500));
        app.Send(new("brightness", "a", 5));
        app.Now = new(2026, 11, 1, 20, 0, 0);
        app.Tick();
        Equal(5, app.Snapshot().Displays[0].Brightness);
        Equal(4500, app.Snapshot().Displays[0].Kelvin);
        app.Now = app.Now.AddMinutes(30);
        app.Tick();
        Equal(8, app.Snapshot().Displays[0].Brightness);
        Equal(3600, app.Snapshot().Displays[0].Kelvin);
        app.Send(new("resume-plan"));
        Equal(50, app.Snapshot().Displays[0].Brightness); // Explicit resume uses the clock position.
        Equal(4600, app.Snapshot().Displays[0].Kelvin);
    }

    public static async Task MissedNodeAsync()
    {
        await using var app = new Fixture(Settings(), new(2026, 11, 1, 19, 59, 59));
        app.Tick();
        app.Send(new("brightness", "a", 5));
        app.Now = new(2026, 11, 1, 20, 30, 0); // Resume after a missed node; do not replay its fade.
        app.Tick();
        Equal(50, app.Snapshot().Displays[0].Brightness);
        Equal(4600, app.Snapshot().Displays[0].Kelvin);
    }

    public static async Task UnrelatedSaveAsync()
    {
        await using var app = new Fixture(Settings(), new(2026, 11, 1, 19, 0, 0));
        app.Tick();
        var saved = app.Snapshot().Settings;
        saved.Language = "zh-CN";
        saved.FocusEnabled = false;
        saved.Scenes[0].Name = "Renamed";
        app.Save(saved);
        app.Tick();
        var snapshot = app.Snapshot();
        Check(!snapshot.Settings.FocusEnabled);
        Equal(saved.Revision, snapshot.Settings.Revision); // No second save from replayed scene rules.
        Equal("时间计划 · Renamed", snapshot.Source);
        app.Send(new("brightness", "a", 33));
        saved = app.Snapshot().Settings;
        saved.Language = "en";
        app.Save(saved);
        app.Tick();
        Equal(33, app.Snapshot().Displays[0].Brightness);
        Check(app.Snapshot().Source.StartsWith("Manual"));
        app.Now = new(2026, 11, 1, 20, 0, 0);
        app.Tick();
        Check(app.Snapshot().Settings.FocusEnabled); // Next node applies its rules once.
    }

    public static async Task PlanEditAsync()
    {
        await using var app = new Fixture(Settings(), new(2026, 11, 1, 19, 0, 0));
        app.Tick();
        var saved = app.Snapshot().Settings;
        saved.Scenes[0].Targets["a"] = new(44, null);
        saved.Scenes[0].Behavior!.FocusEnabled = false;
        app.Save(saved);
        app.Tick();
        Equal(44, app.Snapshot().Displays[0].Brightness);
        Check(!app.Snapshot().Settings.FocusEnabled);
        saved = app.Snapshot().Settings;
        saved.ScheduleEnabled = false;
        app.Save(saved);
        app.Tick();
        Equal("Manual adjustment", app.Snapshot().Source);
        app.Send(new("scene", "night"));
        Equal("Scene · Night", app.Snapshot().Source);
        Equal(10, app.Snapshot().Displays[0].Brightness);
        Check(app.Snapshot().Settings.FocusEnabled);
    }

    public static async Task OfflineBindingAsync()
    {
        var weights = new Dictionary<string, double> { ["a"] = 40, ["b"] = 60, ["offline"] = 1000 };
        var result = RatioBinding.CalculateAvailable(weights, ["a", "b"], "a", 40);
        Equal(40, result["a"]);
        Equal(60, result["b"]);
        Equal(100, RatioBinding.CalculateAvailable(weights, ["a"], "a", 100)["a"]);
        var settings = Settings();
        settings.ScheduleEnabled = false;
        settings.Linked = true;
        settings.LinkWeights = new() { ["a"] = 40, ["offline"] = 1000 };
        await using var app = new Fixture(settings, new(2026, 11, 1));
        var snapshot = app.Send(new("brightness", "b", 77));
        Check(snapshot.Error == null);
        Equal(77, snapshot.Displays.Single(d => d.Id == "b").Brightness);
        Equal(60, snapshot.Displays.Single(d => d.Id == "a").Brightness);
        snapshot = app.Send(new("brightness", "a", 80));
        Equal(80, snapshot.Displays.Single(d => d.Id == "a").Brightness);
        Equal(1000.0, snapshot.Settings.LinkWeights["offline"]); // Preserve the reconnect ratio.
        var linked = snapshot.Settings;
        linked.LinkWeights = weights;
        app.Save(linked);
        snapshot = app.Send(new("brightness", "a", 0));
        Check(snapshot.Displays.All(d => d.Brightness == 0));
        snapshot = app.Send(new("brightness", "a", 20));
        Equal(20, snapshot.Displays.Single(d => d.Id == "a").Brightness);
        Equal(30, snapshot.Displays.Single(d => d.Id == "b").Brightness);
        snapshot = app.Send(new("brightness", "a", 100));
        Equal(67, snapshot.Displays.Single(d => d.Id == "a").Brightness);
        Equal(100, snapshot.Displays.Single(d => d.Id == "b").Brightness);
        Check(!app.Send(new("link", Value: 0)).Settings.Linked);
    }

    public static async Task CalibratedBindingAsync()
    {
        var settings = Settings();
        settings.ScheduleEnabled = false;
        settings.BrightnessLinkCalibration = BrightnessLinkChecks.Calibration();
        await using var app = new Fixture(settings, new(2026, 11, 3, 19, 0, 0));
        app.Send(new("brightness", "a", 0));
        Check(app.Send(new("link", Value: 1)).Error == null); // A measured zero source needs no ratio baseline.
        Equal(25, app.Snapshot().Displays[1].Brightness);
        foreach (var kelvin in new[] { 6500, 4500, 2700 })
        {
            app.Send(new("temperature", Value: kelvin));
            app.Send(new("brightness", "a", 30));
            Equal(30, await app.EffectiveBrightness("a"));
            Equal(65, await app.EffectiveBrightness("b"));
            app.Send(new("brightness", "b", 80));
            Equal(60, app.Snapshot().Displays[0].Brightness);
            app.Send(new("brightness", "a", 98));
            Equal(100, app.Snapshot().Displays[1].Brightness);
            app.Send(new("brightness", "b", 100));
            Equal(98, app.Snapshot().Displays[0].Brightness);
        }
        app.Send(new("brightness", "b", 10));
        Equal(0, app.Snapshot().Displays[0].Brightness);
        Equal(10, app.Snapshot().Displays[1].Brightness);
        app.Send(new("link", Value: 0));
        app.Send(new("brightness", "a", 50));
        Equal(10, app.Snapshot().Displays[1].Brightness);
        var saved = app.Snapshot().Settings;
        saved.Linked = true;
        saved.BrightnessLinkCalibration!.TargetId = "offline";
        app.Save(saved);
        app.Send(new("brightness", "a", 40));
        Equal(10, app.Snapshot().Displays[1].Brightness); // Never remap calibration to a different panel.
        saved = app.Snapshot().Settings;
        saved.BrightnessLinkCalibration!.TargetId = "b";
        saved.Scenes[0].Targets["a"] = new(30, 4500);
        saved.Scenes[0].Targets["b"] = new(1, 4500);
        saved.Scenes[0].Behavior!.Linked = true;
        saved.Scenes[0].Behavior!.LinkWeights = new() { ["a"] = 1, ["b"] = 1 };
        saved.Scenes[1].Targets["a"] = new(10, 2700);
        saved.Scenes[1].Targets["b"] = new(1, 2700);
        saved.Scenes[1].Behavior = saved.Scenes[0].Behavior;
        app.Save(saved);
        app.Send(new("scene", "day"));
        Equal(65, app.Snapshot().Displays[1].Brightness);
        saved = app.Snapshot().Settings;
        saved.ScheduleEnabled = true;
        app.Save(saved);
        app.Now = new(2026, 11, 3, 20, 30, 0);
        app.Tick();
        Equal(20, app.Snapshot().Displays[0].Brightness);
        Equal(55, app.Snapshot().Displays[1].Brightness); // Map after interpolation, rather than interpolating the two panels independently.
        Equal(55, await app.EffectiveBrightness("b"));
    }

    public static Task SettingsRoundTripAsync()
    {
        var directory = Path.Combine(Path.GetTempPath(), "MonitorsFocus-roundtrip-" + Guid.NewGuid().ToString("N"));
        try
        {
            var store = new ControlSettingsStore(directory);
            foreach (var language in new[] { "zh-CN", "en", "system" })
            {
                var settings = Settings();
                settings.Language = language;
                settings.Linked = true;
                settings.LinkWeights = new() { ["a"] = 40, ["b"] = 60 };
                settings.BrightnessLinkCalibration = BrightnessLinkChecks.Calibration();
                settings.ControlledDisplayIds = new() { "b", "offline" };
                settings.FocusEnabled = true;
                settings.FocusDelaySeconds = 27;
                settings.KeepSecondaryAwakeOnFullscreen = false;
                settings.LaunchOnStartup = true;
                settings.Scenes[0].Name = "用户名字 {0}";
                settings.Scenes[0].Behavior = SceneBehavior.Capture(settings);
                store.Save(settings);
                var loaded = store.Load();
                Equal(JsonSerializer.Serialize(settings), JsonSerializer.Serialize(loaded));
                Equal("用户名字 {0}", Localization.SceneName(loaded.Scenes[0], language));
                Check(!JsonSerializer.Serialize(loaded).Contains("Hotkey", StringComparison.OrdinalIgnoreCase));
                var path = Path.Combine(directory, "control-center.json");
                var original = File.ReadAllText(path).Replace("\"FocusDelaySeconds\": 27", "\"FocusDelaySeconds\": 27, \"FocusBrightness\": -5");
                File.WriteAllText(path, original);
                loaded = store.Load();
                Equal(original, File.ReadAllText(path)); // Reading old settings never rewrites the file.
                store.Save(loaded);
                Check(!File.ReadAllText(path).Contains("FocusBrightness"));
            }
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true); }
        return Task.CompletedTask;
    }

    public static async Task FocusPlanFullscreenAsync()
    {
        var settings = Settings();
        settings.FocusDelaySeconds = 0;
        settings.Scenes[0].Targets["b"] = new(60, null);
        settings.Scenes[1].Targets["b"] = new(30, null);
        await using var app = new Fixture(settings, new(2026, 11, 1, 19, 0, 0));
        app.Tick();
        Equal(60, await app.EffectiveBrightness("b")); // Focus only shows an overlay.
        Equal(90, await app.EffectiveBrightness("a")); // Primary is never dimmed.
        app.Now = new(2026, 11, 1, 20, 30, 0);
        app.Tick();
        Equal(45, app.Snapshot().Displays.Single(d => d.Id == "b").Brightness);
        Equal(45, await app.EffectiveBrightness("b"));
        var saved = app.Snapshot().Settings;
        saved.KeepSecondaryAwakeOnFullscreen = true;
        app.Save(saved);
        app.Fullscreen("b");
        app.Tick();
        Equal(45, await app.EffectiveBrightness("b")); // Fullscreen only hides the overlay.
        app.Fullscreen();
        app.Tick();
        Equal(45, await app.EffectiveBrightness("b"));
        app.Send(new("pause"));
        Equal(45, await app.EffectiveBrightness("b"));
        app.Send(new("pause"));
        Equal(45, await app.EffectiveBrightness("b"));
        saved = app.Snapshot().Settings;
        saved.Scenes[1].Behavior!.ControlledDisplayIds = new();
        app.Save(saved);
        app.Send(new("scene", "night"));
        Equal(30, await app.EffectiveBrightness("b"));
        Check(app.Snapshot().Settings.FocusEnabled && app.Snapshot().Settings.ControlledDisplayIds!.Count == 0);
    }

    public static async Task TemperatureCompensationAsync()
    {
        var settings = Settings();
        settings.ScheduleEnabled = false;
        settings.TemperatureBrightnessCalibrations["a"] = TemperatureBrightnessChecks.Calibration();
        settings.TemperatureBrightnessCalibrations["b"] = TemperatureBrightnessChecks.Calibration();
        await using var app = new Fixture(settings, new(2026, 11, 2, 19, 0, 0));
        app.Send(new("brightness", "a", 30));
        app.Send(new("brightness", "b", 30));
        app.Send(new("temperature", "a", 2700));
        app.Send(new("temperature", "b", 2700));
        Equal(30, await app.EffectiveBrightness("a"));
        Equal(50, await app.EffectiveBrightness("b"));
        Equal(30, app.Snapshot().Displays.Single(d => d.Id == "b").Brightness);
        Equal(50, app.Snapshot().Displays.Single(d => d.Id == "b").BacklightTarget);
        var saved = app.Snapshot().Settings;
        saved.TemperatureBrightnessCalibrations["b"].Points[0] = new(2700, 20, 40);
        saved.TemperatureBrightnessCalibrations["b"].Points[1] = new(2700, 40, 70);
        app.Save(saved);
        app.Tick();
        Equal(55, await app.EffectiveBrightness("b"));
        app.Send(new("restore-color"));
        Equal(30, await app.EffectiveBrightness("b"));
        app.Send(new("temperature", "b", 2700));
        app.Send(new("brightness", "b", 90));
        Equal(100, await app.EffectiveBrightness("b"));
        Check(app.Snapshot().Warning != null);
        Equal(30, await app.EffectiveBrightness("a"));
    }

    public static async Task SessionGammaRecoveryAsync()
    {
        var ramp = new GammaColorChecks.FakeRamp();
        var baseline = ramp.Read();
        await using var app = new Fixture(new ControlSettings { FocusEnabled = false },
            new DateTime(2026, 11, 3, 20, 0, 0), ramp);
        app.Send(new("temperature", "a", 3200));
        await app.EffectiveBrightness("a");
        var warm = ramp.Read();
        var writes = ramp.Writes;
        ramp.Current = baseline;
        app.Tick();
        await app.EffectiveBrightness("a");
        Check(ramp.Writes == writes); // Ordinary timer ticks must not poll or write at 20 Hz.
        app.ColorCheckDue();
        app.Tick();
        await app.EffectiveBrightness("a");
        Check(ramp.Current.SequenceEqual(warm) && ramp.Writes == writes + 1);
        app.ColorCheckDue();
        app.Tick();
        await app.EffectiveBrightness("a");
        Check(ramp.Writes == writes + 1); // An unchanged table only needs a read.
        var external = GammaColorDevice.WarmRamp(baseline, 5000);
        ramp.Current = external;
        app.ColorCheckDue();
        app.Tick();
        await app.EffectiveBrightness("a");
        Check(ramp.Current.SequenceEqual(external) && ramp.Writes == writes + 1);
        Check(!app.Snapshot().Displays.Single(d => d.Id == "a").CanAdjustColor);
        Check(app.Snapshot().Displays.Single(d => d.Id == "a").Error != null);
        app.Send(new("brightness", "a", 40));
        Equal(40, await app.EffectiveBrightness("a"));
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private const BindingFlags Flags = BindingFlags.Instance | BindingFlags.NonPublic;
        private readonly ControlCenterContext _app = (ControlCenterContext)RuntimeHelpers.GetUninitializedObject(typeof(ControlCenterContext));
        private readonly string _directory = Path.Combine(Path.GetTempPath(), "MonitorsFocus-integration-" + Guid.NewGuid().ToString("N"));
        private readonly ControlSettingsStore _store;
        private readonly List<ControlledDisplay> _controllers = new();
        private readonly Dictionary<string, FakeColorDevice> _devices = new();
        private readonly System.Windows.Forms.Timer _timer = new();
        public DateTime Now;

        public Fixture(ControlSettings settings, DateTime now, IGammaRamp? gamma = null)
        {
            Now = now;
            _store = new(_directory);
            Set("_store", _store);
            Set("_settings", settings);
            Set("_clock", (Func<DateTime>)(() => Now));
            Set("_timer", _timer);
            Set("_fullscreenDisplays", new HashSet<string>());
            Set("_retainedKelvin", new Dictionary<string, int?>());
            var displayType = typeof(ControlCenterContext).GetNestedType("Display", BindingFlags.NonPublic)!;
            var displays = (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(displayType))!;
            foreach (var id in new[] { "a", "b" })
            {
                var display = Activator.CreateInstance(displayType, nonPublic: true)!;
                var device = new FakeColorDevice();
                _devices[id] = device;
                var controller = id == "a" && gamma != null
                    ? new ControlledDisplay(device, new GammaColorDevice(gamma)) : new ControlledDisplay(device);
                _controllers.Add(controller);
                void Field(string name, object value) => displayType.GetField(name)!.SetValue(display, value);
                Field("Id", id);
                Field("Name", id);
                var monitor = new MonitorInfo(Screen.PrimaryScreen!, IntPtr.Zero);
                typeof(MonitorInfo).GetField("<Id>k__BackingField", Flags)!.SetValue(monitor, id);
                typeof(MonitorInfo).GetField("<IsPrimary>k__BackingField", Flags)!.SetValue(monitor, id == "a");
                // Keep the real pointer outside fake secondary coordinates, without moving it.
                typeof(MonitorInfo).GetField("<Bounds>k__BackingField", Flags)!.SetValue(monitor, new System.Drawing.Rectangle(-100000, -100000, 100, 100));
                Field("Monitor", monitor);
                Field("Controller", controller);
                Field("IsInternal", id == "b");
                Field("Brightness", 60);
                displays.Add(display);
            }
            Set("_displays", displays);
        }

        private void Set(string name, object value) => typeof(ControlCenterContext).GetField(name, Flags)!.SetValue(_app, value);
        private object? Invoke(string name, params object?[] args) => typeof(ControlCenterContext).GetMethod(name, Flags)!.Invoke(_app, args);
        public void Tick() { Set("_nextPlanAt", 0L); Invoke("Tick"); }
        public void ColorCheckDue()
        {
            foreach (var display in (IList)typeof(ControlCenterContext).GetField("_displays", Flags)!.GetValue(_app)!)
                display!.GetType().GetField("NextColorCheck")!.SetValue(display, 0L);
        }
        public ControlSnapshot Snapshot() => (ControlSnapshot)Invoke("Snapshot", new object?[] { null })!;
        public ControlSnapshot Send(ControlRequest request) => (ControlSnapshot)Invoke("Handle", request)!;
        public void EdgeBrightness(string id, int steps) => Invoke("ApplyEdgeWheel", new EdgeWheelAction(id, steps));
        public void EdgeTemperature(string id, int steps) => Invoke("ApplyEdgeWheel", new EdgeWheelAction(id, steps, true));
        public void Fullscreen(params string[] ids)
        {
            Set("_fullscreenDisplays", ids.ToHashSet());
            Set("_nextFullscreenAt", long.MaxValue); // Inject a detector result; no desktop enumeration.
        }
        public async Task<int> EffectiveBrightness(string id)
        {
            var controller = _controllers[id == "a" ? 0 : 1];
            var worker = (Task)typeof(ControlledDisplay).GetField("_worker", Flags)!.GetValue(controller)!;
            await worker;
            return _devices[id].Brightness;
        }
        public void Save(ControlSettings settings)
        {
            // Exercise the post-persistence path without touching the user's startup registry.
            _store.Save(settings);
            Invoke("ApplySavedSettings", settings);
        }
        public async ValueTask DisposeAsync()
        {
            _timer.Dispose();
            foreach (var controller in _controllers) await controller.CloseAsync();
            if (Directory.Exists(_directory)) Directory.Delete(_directory, recursive: true);
        }
    }

    private static void Check(bool condition) { if (!condition) throw new Exception("Control center integration assertion failed."); }
    private static void Equal<T>(T expected, T actual)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual)) throw new Exception($"Expected {expected}, got {actual}.");
    }
}
