using System.Text.Json;
using MonitorsFocus.Core;

internal static class BrightnessLinkChecks
{
    internal static BrightnessLinkCalibration Calibration() => new()
    {
        SourceId = "a", TargetId = "b",
        Points = [new(0, 25), new(5, 35), new(10, 45), new(20, 55), new(30, 65),
            new(40, 70), new(50, 75), new(60, 80), new(70, 85), new(80, 90), new(95, 100), new(100, 100)]
    };

    public static Task CurveAsync()
    {
        var curve = Calibration();
        curve.Validate();
        foreach (var point in curve.Points) Equal(point.Target, curve.MapToTarget(point.Source));
        for (var x = 0; x <= 100; x++)
        {
            var expected = x <= 10 ? 2 * x + 25 : x <= 30 ? x + 35 : x <= 80 ? .5 * x + 50 : x <= 95 ? (2 * x + 110) / 3.0 : 100;
            Equal((int)Math.Round(expected), curve.MapToTarget(x));
        }
        Equal(20, curve.MapToSource(55, 0));
        Equal(0, curve.MapToSource(10, 30));
        Equal(95, curve.MapToSource(100, 40));
        Equal(98, curve.MapToSource(100, 98));
        for (var y = 25; y < 100; y++)
            if (Math.Abs(y - curve.MapToTarget(curve.MapToSource(y, 0))) > 1) throw new Exception("Inverse mismatch.");
        var settings = new ControlSettings { BrightnessLinkCalibration = curve };
        var restored = JsonSerializer.Deserialize<ControlSettings>(JsonSerializer.Serialize(settings))!;
        Equal(65, restored.BrightnessLinkCalibration!.MapToTarget(30));
        Equal<BrightnessLinkCalibration?>(null, JsonSerializer.Deserialize<ControlSettings>("{}")!.BrightnessLinkCalibration);
        return Task.CompletedTask;
    }

    public static Task ValidationAsync()
    {
        foreach (var invalid in new[]
        {
            new BrightnessLinkCalibration { SourceId = "a", TargetId = "a", Points = [new(0, 25), new(100, 100)] },
            new BrightnessLinkCalibration { SourceId = "a", TargetId = "b", Points = [new(5, 25), new(100, 100)] },
            new BrightnessLinkCalibration { SourceId = "a", TargetId = "b", Points = [new(0, 25), new(0, 30), new(100, 100)] },
            new BrightnessLinkCalibration { SourceId = "a", TargetId = "b", Points = [new(0, 25), new(50, 20), new(100, 100)] }
        })
        {
            try { DailyPlan.Validate(new() { BrightnessLinkCalibration = invalid }); }
            catch (ArgumentException) { continue; }
            throw new Exception("Invalid brightness calibration accepted.");
        }
        return Task.CompletedTask;
    }

    private static void Equal<T>(T expected, T actual)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual)) throw new Exception($"Expected {expected}, got {actual}.");
    }
}
