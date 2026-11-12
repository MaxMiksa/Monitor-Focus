using System.Drawing;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using MonitorsFocus.Core;
using MonitorsFocus.Monitoring;
using MonitorsFocus.Overlay;
using MonitorsFocus.Settings;

internal static class EdgeWheelChecks
{
    public static Task GesturesAsync()
    {
        EdgeWheelTarget[] targets = [new("left", new(-1920, -1080, 1920, 1080), true),
            new("right", new(0, 0, 2560, 1440), true), new("unsupported", new(2560, 0, 800, 600), false)];
        Equal<(string, bool)?>(("left", true), EdgeWheelGesture.HitTest(targets, new(-1900, -1080), true, true));
        Equal<(string, bool)?>(("left", false), EdgeWheelGesture.HitTest(targets, new(-1, -1), true, true));
        Equal<(string, bool)?>(("right", false), EdgeWheelGesture.HitTest(targets, new(2559, 1439), true, true));
        Equal<(string, bool)?>(null, EdgeWheelGesture.HitTest(targets, new(100, 1), true, true));
        Equal<(string, bool)?>(null, EdgeWheelGesture.HitTest(targets, new(100, 1440), true, true));
        Equal<(string, bool)?>(null, EdgeWheelGesture.HitTest(targets, new(-1, 0), true, true)); // gap
        Equal<(string, bool)?>(null, EdgeWheelGesture.HitTest(targets, new(2600, 0), true, true));
        Equal<(string, bool)?>(("unsupported", false), EdgeWheelGesture.HitTest(targets, new(2600, 599), true, true));
        Equal<(string, bool)?>(null, EdgeWheelGesture.HitTest(targets, new(100, 0), false, true));
        Equal<(string, bool)?>(null, EdgeWheelGesture.HitTest(targets, new(100, 1439), true, false));

        var gesture = new EdgeWheelGesture();
        Equal(0, gesture.Add(("left", true), 60, 0));
        Equal(1, gesture.Add(("left", true), 60, 20));
        Equal(-2, gesture.Add(("left", true), -240, 30));
        Equal(0, gesture.Add(("left", true), 60, 40));
        Equal(0, gesture.Add(("right", true), 60, 50)); // no cross-monitor remainder
        Equal(0, gesture.Add(("right", false), 60, 60)); // no cross-edge remainder
        Equal(0, gesture.Add(("right", false), 60, 561)); // timeout
        Equal(0, gesture.Add(null, 0, 562));
        Equal(0, gesture.Add(("right", false), -60, 563)); // leaving the edge clears remainder
        Equal(0, gesture.Add(("right", false), 60, 564)); // opposite fractional motion cancels
        Equal(1, gesture.Add(("right", false), 120, 565));
        return Task.CompletedTask;
    }

    public static Task SettingsAsync()
    {
        var directory = Path.Combine(Path.GetTempPath(), "MonitorsFocus-edge-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            File.WriteAllText(Path.Combine(directory, "control-center.json"), "{}");
            var store = new ControlSettingsStore(directory);
            var settings = store.Load();
            Equal(false, settings.TopEdgeBrightnessEnabled);
            Equal(false, settings.BottomEdgeVolumeEnabled);
            Equal("alt", settings.EdgeWheelModifier);
            foreach (var top in new[] { false, true }) foreach (var bottom in new[] { false, true })
            foreach (var modifier in new[] { "alt", "ctrl", "shift" })
            {
                settings.TopEdgeBrightnessEnabled = top;
                settings.BottomEdgeVolumeEnabled = bottom;
                settings.EdgeWheelModifier = modifier;
                store.Save(settings);
                settings = store.Load();
                Equal(top, settings.TopEdgeBrightnessEnabled);
                Equal(bottom, settings.BottomEdgeVolumeEnabled);
                Equal(modifier, settings.EdgeWheelModifier);
                var scene = new Scene { Behavior = new() { FocusEnabled = true } };
                scene.Behavior.ApplyTo(settings);
                Equal(top, settings.TopEdgeBrightnessEnabled);
                Equal(bottom, settings.BottomEdgeVolumeEnabled);
                Equal(top, JsonSerializer.Deserialize<ControlSettings>(JsonSerializer.Serialize(settings))!.TopEdgeBrightnessEnabled);
                Equal(modifier, settings.EdgeWheelModifier); // Scenes do not override the global modifier.
            }
            foreach (var invalid in new[] { "win", "Alt", "", "alt+ctrl", null })
            {
                settings.EdgeWheelModifier = invalid!;
                var rejected = false;
                try { store.Save(settings); } catch (ArgumentException) { rejected = true; }
                Equal(true, rejected);
                Equal("shift", store.Load().EdgeWheelModifier); // Failed validation leaves the saved choice intact.
            }
        }
        finally { Directory.Delete(directory, true); }
        return Task.CompletedTask;
    }

    public static Task AlternateAsync()
    {
        Equal<bool?>(false, EdgeWheelGesture.Mode(false, false, false, false, false));
        Equal<bool?>(true, EdgeWheelGesture.Mode(false, false, true, false, false));
        Equal<bool?>(null, EdgeWheelGesture.Mode(true, false, false, false, false));
        Equal<bool?>(null, EdgeWheelGesture.Mode(true, true, false, false, false));
        Equal<bool?>(null, EdgeWheelGesture.Mode(true, false, true, false, false)); // AltGr also passes through.
        Equal<bool?>(null, EdgeWheelGesture.Mode(true, false, false, true, false));
        Equal<bool?>(null, EdgeWheelGesture.Mode(true, false, false, false, true));
        foreach (var modifier in new[] { "alt", "ctrl", "shift" })
        for (var mask = 0; mask < 32; mask++)
        {
            var control = (mask & 1) != 0;
            var shift = (mask & 2) != 0;
            var alt = (mask & 4) != 0;
            var windows = (mask & 8) != 0;
            var buttons = (mask & 16) != 0;
            var selectedMask = modifier == "ctrl" ? 1 : modifier == "shift" ? 2 : 4;
            bool? expected = mask == 0 ? false : mask == selectedMask ? true : null;
            Equal(expected, EdgeWheelGesture.Mode(control, shift, alt, windows, buttons, modifier));
        }
        Equal<bool?>(null, EdgeWheelGesture.Mode(false, false, true, false, false, "invalid"));
        EdgeWheelTarget[] targets = [new("color", new(0, 0, 100, 100), true, true), new("brightness-only", new(100, 0, 100, 100), true)];
        Equal<(string, bool)?>(("color", true), EdgeWheelGesture.HitTest(targets, new(50, 0), true, true, true));
        Equal<(string, bool)?>(null, EdgeWheelGesture.HitTest(targets, new(150, 0), true, true, true));
        var gesture = new EdgeWheelGesture();
        Equal(0, gesture.Add(("color", true), 60, 0));
        Equal(0, gesture.Add(("color", true), 60, 1, true));
        Equal(1, gesture.Add(("color", true), 60, 2, true));
        Equal(0, gesture.Add(("color", false), 60, 3, true, new IntPtr(1)));
        Equal(0, gesture.Add(("color", false), 60, 4, true, new IntPtr(2)));
        Equal(1, gesture.Add(("color", false), 60, 5, true, new IntPtr(2)));
        var processes = new Dictionary<uint, AudioProcess>
        {
            [1] = new(1, 0, "explorer", 1), [10] = new(10, 1, "browser", 10),
            [11] = new(11, 10, "browser", 11), [12] = new(12, 10, "browser", 12),
            [20] = new(20, 1, "browser", 20), [21] = new(21, 10, "player", 21),
            [30] = new(30, 10, "browser", 9) // Parent PID has been reused.
        };
        Equal(true, ForegroundAudioTarget.BelongsTo(12, 11, processes));
        Equal(true, ForegroundAudioTarget.BelongsTo(10, 11, processes));
        Equal(false, ForegroundAudioTarget.BelongsTo(20, 11, processes));
        Equal(false, ForegroundAudioTarget.BelongsTo(21, 11, processes));
        Equal(false, ForegroundAudioTarget.BelongsTo(30, 11, processes));
        Equal(false, ForegroundAudioTarget.BelongsTo(0, 11, processes));
        Equal(1f, ApplicationVolume.TargetLevel(0.99f, 1));
        Equal(0f, ApplicationVolume.TargetLevel(0.01f, -1));
        Equal(0.52f, ApplicationVolume.TargetLevel(0.5f, 1));
        var audio = new ForegroundAudioTarget(new IntPtr(1), 10, 1);
        var request = new SystemVolume.Request(1, 1, audio, 5);
        Equal(true, SystemVolume.CanMerge(request, request with { Target = audio with { CapturedAt = 2 }, Feedback = 6 }));
        Equal(false, SystemVolume.CanMerge(request, request with { Steps = -1 })); // Keep direction changes at the limits.
        Equal(false, SystemVolume.CanMerge(request, request with { Generation = 2 }));
        Equal(false, SystemVolume.CanMerge(request, request with { Target = null }));
        Equal(false, SystemVolume.CanMerge(request, request with { Target = audio with { Window = new IntPtr(2) } }));
        Equal(true, MonitorsFocus.ControlCenterContext.MatchesApplicationFeedback(audio, 5, 5, audio));
        Equal(true, MonitorsFocus.ControlCenterContext.MatchesApplicationFeedback(audio, 5, 6, audio));
        Equal(false, MonitorsFocus.ControlCenterContext.MatchesApplicationFeedback(audio, 7, 6, audio)); // Returning to the app starts a new feedback interval.
        Equal(false, MonitorsFocus.ControlCenterContext.MatchesApplicationFeedback(null, 5, 6, audio)); // Another edge mode is active.
        Equal(false, MonitorsFocus.ControlCenterContext.MatchesApplicationFeedback(audio, 5, 6, audio with { ProcessId = 20 }));
        return Task.CompletedTask;
    }

    public static Task PreviewAsync()
    {
        var audio = new ForegroundAudioTarget(new IntPtr(1), 10, 1);
        var preview = new ApplicationVolumePreview();
        preview.Add(1, 1);
        preview.Add(2, 1);
        preview.Add(3, -1);
        Equal<int?>(null, preview.Level); // Never invent the first mixer value.
        Equal(true, preview.Confirm(new(audio, "player", 50, true), 1));
        Equal<int?>(50, preview.Level); // Replay +2 and -2 after the confirmed 50%.
        preview.Add(4, 1);
        Equal<int?>(52, preview.Level); // UI moves before a worker callback.
        Equal(true, preview.Confirm(new(audio, "player", 52, true), 2));
        Equal<int?>(52, preview.Level); // An intermediate result cannot pull it back.
        Equal(false, preview.Confirm(new(audio, "player", 50, false), 1));
        Equal(true, preview.Value!.Muted);
        Equal(true, preview.Confirm(new(audio, "player", 40, false), 3));
        Equal<int?>(42, preview.Level); // External mixer edit + still-pending input.
        preview.Confirm(new(audio, "player", 42, false), 4);
        Equal<int?>(42, preview.Level);
        preview.Add(5, 100);
        preview.Add(6, -1);
        Equal<int?>(98, preview.Level);
        preview.Confirm(new(audio, "player", 100, false), 5);
        Equal<int?>(98, preview.Level);
        preview.Add(7, -100);
        preview.Add(8, 1);
        Equal<int?>(2, preview.Level);
        preview.Confirm(new(audio, "player", 0, false), 7);
        Equal<int?>(2, preview.Level);
        preview.Clear(); // Target/mode change, disable or error discards all guesses.
        Equal<int?>(null, preview.Level);
        Equal<ApplicationVolumeFeedback?>(null, preview.Value);
        for (var version = 1; version <= 128; version++) preview.Add(version, 1);
        Equal(false, preview.CanAdd);
        preview.Confirm(new(audio, "other", 50, false), 128); // Latest coalesced callback.
        Equal(true, preview.CanAdd);
        Equal<int?>(50, preview.Level);
        return Task.CompletedTask;
    }

    public static async Task HookLifecycleAsync()
    {
        var errors = new System.Collections.Concurrent.ConcurrentQueue<string>();
        using var hook = new EdgeWheelService(errors.Enqueue);
        var field = typeof(EdgeWheelService).GetField("_hook", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var input = typeof(EdgeWheelService).GetNestedType("MouseInput", BindingFlags.NonPublic)!;
        Equal(IntPtr.Size == 8 ? 32 : 24, Marshal.SizeOf(input));
        Equal(IntPtr.Zero, (IntPtr)field.GetValue(hook)!);
        // An unreachable rectangle tests the real native lifecycle without intercepting user input.
        hook.Update(true, true, [new("fixture", new(-100000, -100000, 10, 10), true)]);
        await Until(() => (IntPtr)field.GetValue(hook)! != IntPtr.Zero || !errors.IsEmpty);
        if (errors.TryDequeue(out var error)) throw new Exception(error);
        Equal(false, hook.TryRead(out _));
        hook.Update(false, false, []);
        await Until(() => (IntPtr)field.GetValue(hook)! == IntPtr.Zero);
    }

    public static async Task OsdQueueAsync()
    {
        var shown = new System.Collections.Concurrent.ConcurrentQueue<HardwareOsd>();
        var errors = new System.Collections.Concurrent.ConcurrentQueue<string>();
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        await using var osd = new NativeHardwareOsd(errors.Enqueue, kind =>
        {
            shown.Enqueue(kind);
            if (kind == HardwareOsd.Volume)
            {
                entered.Set();
                if (!release.Wait(3000)) throw new TimeoutException("OSD fixture timed out.");
            }
            else throw new InvalidOperationException("Shell unavailable");
        }, () => true);
        osd.SetEnabled(true, true);
        try
        {
            osd.Request(HardwareOsd.Volume);
            await Until(() => entered.IsSet);
            // A slow shell must not grow the queue or replay a disabled feature.
            for (var i = 0; i < 10000; i++) osd.Request(HardwareOsd.Brightness);
            osd.SetEnabled(false, false);
            release.Set();
            await osd.DisposeAsync();
            Equal(1, shown.Count);
            Equal(true, errors.IsEmpty);
        }
        finally { release.Set(); }

        await using var failing = new NativeHardwareOsd(errors.Enqueue,
            _ => throw new InvalidOperationException("Shell unavailable"), () => true);
        failing.SetEnabled(true, false);
        failing.Request(HardwareOsd.Brightness);
        await Until(() => !errors.IsEmpty);
        Equal("Shell unavailable", errors.Single());
        // Background sessions never activate the shell, even with the switches on.
        var rejected = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var background = new NativeHardwareOsd(errors.Enqueue, shown.Enqueue,
            () => { rejected.TrySetResult(); return false; });
        background.SetEnabled(true, true);
        background.Request(HardwareOsd.Brightness);
        await rejected.Task.WaitAsync(TimeSpan.FromSeconds(3));
        await background.DisposeAsync();
        Equal(1, shown.Count);
    }

    private static async Task Until(Func<bool> condition)
    {
        var until = Environment.TickCount64 + 3000;
        while (!condition())
        {
            if (Environment.TickCount64 >= until) throw new Exception("Hook lifecycle timed out.");
            await Task.Delay(20);
        }
    }

    private static void Equal<T>(T expected, T actual)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual)) throw new Exception($"Expected {expected}, got {actual}.");
    }
}
