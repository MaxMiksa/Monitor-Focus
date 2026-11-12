using System.Text.Json;
using MonitorsFocus.Brightness;
using MonitorsFocus.Core;

internal static class TemperatureBrightnessChecks
{
    internal static TemperatureBrightnessCalibration Calibration() => new()
    {
        Points = [new(2700, 20, 36), new(2700, 40, 64), new(4500, 20, 27), new(4500, 40, 50)]
    };

    public static Task InterpolationAsync()
    {
        var calibration = Calibration();
        calibration.Validate();
        Check(calibration.Evaluate(20, 2700) == new CompensatedBrightness(36, false));
        Check(calibration.Evaluate(30, 2700) == new CompensatedBrightness(50, false));
        Check(calibration.Evaluate(30, 4500) == new CompensatedBrightness(38, false));
        Check(calibration.Evaluate(30, 5500) == new CompensatedBrightness(34, false));
        Check(calibration.Evaluate(90, 2700) == new CompensatedBrightness(100, true));
        Check(calibration.Evaluate(60, 6500) == new CompensatedBrightness(60, false));
        Check(calibration.Evaluate(60, null) == new CompensatedBrightness(60, false));
        Check(calibration.Evaluate(0, 2700) == new CompensatedBrightness(0, false));
        var previous = 0;
        for (var level = 0; level <= 100; level++)
        {
            var actual = calibration.Evaluate(level, 3500).Value;
            Check(actual >= previous && actual >= level && actual <= 100);
            previous = actual;
        }
        return Task.CompletedTask;
    }

    public static Task ValidationAsync()
    {
        var original = Calibration();
        var copy = JsonSerializer.Deserialize<TemperatureBrightnessCalibration>(JsonSerializer.Serialize(original))!;
        copy.Validate();
        Check(copy.Evaluate(30, 2700) == original.Evaluate(30, 2700));
        var invalid = Calibration();
        invalid.Points.RemoveAt(0);
        Throws(invalid.Validate);
        invalid = Calibration();
        invalid.Points[0] = new(2700, 20, 19);
        Throws(invalid.Validate);
        invalid = Calibration();
        invalid.Points[0] = new(2700, 20, 80);
        Throws(invalid.Validate);
        invalid = Calibration();
        invalid.Points[2] = new(4500, 20, 37);
        Throws(invalid.Validate);
        var legacy = JsonSerializer.Deserialize<ControlSettings>("{}")!;
        Check(legacy.TemperatureBrightnessCalibrations.Count == 0);
        return Task.CompletedTask;
    }

    public static async Task RestoreAsync()
    {
        var events = new List<string>();
        var brightness = new RecordingBrightness(events);
        var temperature = new RecordingTemperature(events);
        var controller = new ControlledDisplay(brightness, temperature);
        await controller.ApplyAsync(30, 50, 2700);
        Check(events.SequenceEqual(["color:2700", "brightness:50"]));
        events.Clear();
        await controller.ApplyAsync(30, 30, null);
        Check(events.SequenceEqual(["brightness:30", "color:native"]));
        await controller.ApplyAsync(20, 36, 2700);
        await controller.CloseAsync();
        Check(brightness.Value == 20 && temperature.Kelvin == null && brightness.Disposed && temperature.Disposed);
    }

    public static async Task ColorFailureAsync()
    {
        var events = new List<string>();
        var brightness = new RecordingBrightness(events);
        var temperature = new RecordingTemperature(events);
        var controller = new ControlledDisplay(brightness, temperature);
        await controller.ApplyAsync(30, 40, 4500);
        temperature.RejectWarm = true;
        await controller.ApplyAsync(30, 50, 2700);
        Check(brightness.Value == 30 && controller.Error != null && !controller.SupportsColor);
        await controller.ApplyAsync(20, 36, 2700);
        Check(brightness.Value == 20);
        await controller.CloseAsync();
    }

    private static void Check(bool value) { if (!value) throw new Exception("Temperature brightness assertion failed."); }
    private static void Throws(Action action)
    {
        try { action(); } catch (ArgumentException) { return; }
        throw new Exception("Invalid temperature brightness calibration was accepted.");
    }

    private sealed class RecordingBrightness(List<string> events) : IBrightnessDevice
    {
        public int Value = 30;
        public bool Disposed;
        public int ReadBrightness() => Value;
        public void SetBrightness(int value) { events.Add($"brightness:{value}"); Value = value; }
        public void Dispose() => Disposed = true;
    }
    private sealed class RecordingTemperature(List<string> events) : ITemperatureDevice
    {
        public int? Kelvin;
        public bool Disposed, RejectWarm;
        public void Apply(int? kelvin)
        {
            if (RejectWarm && kelvin.HasValue) throw new InvalidOperationException("Color rejected.");
            Kelvin = kelvin;
            events.Add($"color:{kelvin?.ToString() ?? "native"}");
        }
        public void Dispose() => Disposed = true;
    }
}
