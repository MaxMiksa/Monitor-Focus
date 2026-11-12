using MonitorsFocus.Brightness;

internal static class GammaColorChecks
{
    public static Task ForegroundScopeAsync()
    {
        const string panel = @"DISPLAY\AOC\physical";
        Check(MonitorsFocus.Monitoring.PhysicalDisplayScope.Matches(1, 1, panel, panel.ToLowerInvariant()));
        Check(!MonitorsFocus.Monitoring.PhysicalDisplayScope.Matches(4, 1, panel, panel));
        Check(!MonitorsFocus.Monitoring.PhysicalDisplayScope.Matches(1, 4, panel, panel));
        Check(!MonitorsFocus.Monitoring.PhysicalDisplayScope.Matches(1, uint.MaxValue, panel, panel));
        Check(!MonitorsFocus.Monitoring.PhysicalDisplayScope.Matches(1, 1, panel, @"DISPLAY\RDP\remote"));
        Check(!MonitorsFocus.Monitoring.PhysicalDisplayScope.Matches(1, 1, panel, null));
        Check(!MonitorsFocus.Monitoring.PhysicalDisplayScope.Matches(1, 1, null, null));
        return Task.CompletedTask;
    }

    public static Task BaselineAsync()
    {
        var ramp = new FakeRamp();
        var baseline = ramp.Read();
        using var color = new GammaColorDevice(ramp);
        color.Apply(6500);
        Check(ramp.Writes == 0);
        color.Apply(3500);
        var warm = ramp.Read();
        Check(warm[255] == baseline[255] && warm[511] < baseline[511] && warm[767] < warm[511]);
        for (var channel = 0; channel < 3; channel++)
            for (var i = 1; i < 256; i++) Check(warm[channel * 256 + i] >= warm[channel * 256 + i - 1]);
        var warmest = GammaColorDevice.WarmRamp(baseline, 2700);
        for (var i = 0; i < warmest.Length; i++) Check(Math.Abs(warmest[i] - (i % 256) * 257) <= 32768);
        Check(warmest[767] < warm[767]);
        var writes = ramp.Writes;
        color.Apply(3500);
        Check(ramp.Writes == writes);
        color.Apply(null);
        Check(ramp.Read().SequenceEqual(baseline));
        var replacement = GammaColorDevice.WarmRamp(baseline, 5000);
        ramp.Current = replacement;
        color.Apply(4500);
        color.Apply(6500);
        Check(ramp.Read().SequenceEqual(replacement));
        return Task.CompletedTask;
    }

    public static Task ConflictAsync()
    {
        var ramp = new FakeRamp();
        using var color = new GammaColorDevice(ramp);
        color.Apply(3500);
        var external = GammaColorDevice.WarmRamp(FakeRamp.Identity(), 5000);
        ramp.Current = external;
        Throws(() => color.Apply(4500));
        color.Apply(null);
        Check(ramp.Read().SequenceEqual(external));
        return Task.CompletedTask;
    }

    public static Task RejectionAsync()
    {
        var ramp = new FakeRamp { IgnoreWrites = true };
        using (var color = new GammaColorDevice(ramp)) Throws(() => color.Apply(3500));
        Check(ramp.Disposed);
        ramp = new FakeRamp { RejectAfterWrite = true };
        var baseline = ramp.Read();
        using (var color = new GammaColorDevice(ramp))
        {
            Throws(() => color.Apply(3500));
            ramp.RejectAfterWrite = false;
            color.Apply(null);
            Check(ramp.Read().SequenceEqual(baseline));
        }
        return Task.CompletedTask;
    }

    public static Task AdvancedColorAsync()
    {
        var ramp = new FakeRamp { IsSdr = false };
        using var color = new GammaColorDevice(ramp);
        Throws(() => color.Apply(3500));
        Check(ramp.Writes == 0);
        ramp.IsSdr = true;
        color.Apply(3500);
        var writes = ramp.Writes;
        ramp.IsSdr = false;
        color.Apply(null);
        Check(ramp.Writes == writes);
        return Task.CompletedTask;
    }

    public static async Task IsolationAsync()
    {
        var first = new FakeRamp();
        var second = new FakeRamp();
        var baseline = first.Read();
        using (var a = new GammaColorDevice(first))
        using (var b = new GammaColorDevice(second))
        {
            a.Apply(3500);
            Check(second.Read().SequenceEqual(baseline));
            b.Apply(4500);
            Check(!first.Read().SequenceEqual(second.Read()));
        }
        Check(first.Current.SequenceEqual(baseline) && second.Current.SequenceEqual(baseline));

        var hardware = new FakeColorDevice();
        var gamma = new FakeRamp();
        var controller = new ControlledDisplay(hardware, new GammaColorDevice(gamma));
        await controller.ApplyAsync(60, 60, 3500);
        Check(controller.SupportsColor && hardware.GainWrites == 0 && gamma.Writes == 1);
        await controller.CloseAsync();
        Check(gamma.Current.SequenceEqual(baseline) && gamma.Disposed && hardware.Disposed);
    }

    public static async Task FailureIsolationAsync()
    {
        var brightness = new FakeDevice();
        var gamma = new FakeRamp { IgnoreWrites = true };
        var controller = new ControlledDisplay(brightness, new GammaColorDevice(gamma));
        await controller.ApplyAsync(50, 50, 3500);
        Check(!controller.SupportsColor && controller.Error != null && brightness.Brightness == 50);
        await controller.ApplyAsync(40, 40, 4000);
        Check(brightness.Brightness == 40);
        await controller.CloseAsync();
        Check(brightness.Disposed && gamma.Disposed);
    }

    private static void Check(bool value) { if (!value) throw new Exception("Gamma assertion failed."); }
    private static void Throws(Action action)
    {
        try { action(); }
        catch (InvalidOperationException) { return; }
        throw new Exception("Expected gamma operation to be rejected.");
    }

    internal sealed class FakeRamp : IGammaRamp
    {
        public bool IsSdr { get; set; } = true;
        public ushort[] Current = Identity();
        public int Writes;
        public bool IgnoreWrites, RejectAfterWrite, Disposed;
        public static ushort[] Identity() => Enumerable.Range(0, 768).Select(i => (ushort)((i % 256) * 257)).ToArray();
        public ushort[] Read() => (ushort[])Current.Clone();
        public bool Write(ushort[] ramp)
        {
            ObjectDisposedException.ThrowIf(Disposed, this);
            Writes++;
            if (!IgnoreWrites) Current = (ushort[])ramp.Clone();
            return !RejectAfterWrite;
        }
        public void Dispose() => Disposed = true;
    }
}
