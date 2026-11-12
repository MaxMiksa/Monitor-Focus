namespace MonitorsFocus.Core;

public sealed record TemperatureBrightnessPoint(int Kelvin, int ReferenceBrightness, int CompensatedBrightness);
public readonly record struct CompensatedBrightness(int Value, bool Limited);

public sealed class TemperatureBrightnessCalibration
{
    public List<TemperatureBrightnessPoint> Points { get; set; } = new();

    public CompensatedBrightness Evaluate(int brightness, int? kelvin)
    {
        brightness = Math.Clamp(brightness, 0, 100);
        if (brightness == 0 || !kelvin.HasValue || kelvin >= 6500 || Points.Count == 0) return new(brightness, false);
        var minimum = 6500;
        foreach (var point in Points) minimum = Math.Min(minimum, point.Kelvin);
        var temperature = Math.Clamp(kelvin.Value, minimum, 6500);
        var lower = minimum;
        var upper = 6500;
        foreach (var point in Points)
        {
            if (point.Kelvin <= temperature) lower = Math.Max(lower, point.Kelvin);
            if (point.Kelvin >= temperature) upper = Math.Min(upper, point.Kelvin);
        }
        var lowOffset = Offset(brightness, lower);
        var highOffset = upper == 6500 ? 0 : Offset(brightness, upper);
        var offset = lower == upper ? lowOffset : lowOffset + (highOffset - lowOffset) * (temperature - lower) / (upper - lower);
        var requested = brightness + offset;
        return new(Math.Clamp((int)Math.Round(requested), brightness, 100), requested > 100);
    }

    private double Offset(int brightness, int kelvin)
    {
        TemperatureBrightnessPoint? before = null, after = null;
        foreach (var point in Points)
        {
            if (point.Kelvin != kelvin) continue;
            if (point.ReferenceBrightness <= brightness && (before == null || point.ReferenceBrightness > before.ReferenceBrightness)) before = point;
            if (point.ReferenceBrightness >= brightness && (after == null || point.ReferenceBrightness < after.ReferenceBrightness)) after = point;
        }
        if (before == null)
            return after == null ? 0 : (after.CompensatedBrightness - after.ReferenceBrightness) * brightness / (double)after.ReferenceBrightness;
        var offset = before.CompensatedBrightness - before.ReferenceBrightness;
        // Above the measured range, retain the nearest measured boost rather than inventing a response curve.
        if (after == null || before.ReferenceBrightness == after.ReferenceBrightness) return offset;
        var progress = (brightness - before.ReferenceBrightness) / (double)(after.ReferenceBrightness - before.ReferenceBrightness);
        return offset + (after.CompensatedBrightness - after.ReferenceBrightness - offset) * progress;
    }

    public void Validate()
    {
        if (Points == null || Points.Count is < 4 or > 32 ||
            Points.Any(p => p == null || p.Kelvin is < 2700 or >= 6500 || p.ReferenceBrightness is < 1 or > 99 ||
                p.CompensatedBrightness < p.ReferenceBrightness || p.CompensatedBrightness > 100) ||
            Points.Select(p => (p.Kelvin, p.ReferenceBrightness)).Distinct().Count() != Points.Count)
            throw new ArgumentException("色温亮度校准数据无效。");
        var curves = Points.GroupBy(p => p.Kelvin).OrderBy(g => g.Key).ToArray();
        var references = curves[0].Select(p => p.ReferenceBrightness).Order().ToArray();
        if (curves.Length < 2 || references.Length < 2 || curves.Any(g => !g.Select(p => p.ReferenceBrightness).Order().SequenceEqual(references)))
            throw new ArgumentException("色温亮度校准需要两个亮度和两个暖度的完整参照。");
        foreach (var curve in curves)
        {
            var ordered = curve.OrderBy(p => p.ReferenceBrightness).ToArray();
            for (var i = 1; i < ordered.Length; i++)
                if (ordered[i].CompensatedBrightness < ordered[i - 1].CompensatedBrightness)
                    throw new ArgumentException("色温亮度校准曲线必须随亮度递增。");
        }
        foreach (var reference in references)
        {
            var ordered = Points.Where(p => p.ReferenceBrightness == reference).OrderBy(p => p.Kelvin).ToArray();
            for (var i = 1; i < ordered.Length; i++)
                if (ordered[i].CompensatedBrightness > ordered[i - 1].CompensatedBrightness)
                    throw new ArgumentException("较暖色温的补光不能小于较冷色温。");
        }
    }
}
