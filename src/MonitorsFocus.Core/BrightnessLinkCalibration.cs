namespace MonitorsFocus.Core;

public sealed record BrightnessMatchPoint(int Source, int Target);

public sealed class BrightnessLinkCalibration
{
    public string SourceId { get; set; } = "";
    public string TargetId { get; set; } = "";
    public List<BrightnessMatchPoint> Points { get; set; } = new();

    public void Validate()
    {
        if (string.IsNullOrWhiteSpace(SourceId) || string.IsNullOrWhiteSpace(TargetId) || SourceId == TargetId ||
            Points == null || Points.Count is < 2 or > 101 || Points[0].Source != 0 || Points[^1].Source != 100)
            throw new ArgumentException("亮度联动校准数据无效。");
        for (var i = 0; i < Points.Count; i++)
        {
            var point = Points[i];
            if (point == null || point.Source is < 0 or > 100 || point.Target is < 0 or > 100 ||
                (i > 0 && (point.Source <= Points[i - 1].Source || point.Target < Points[i - 1].Target)))
                throw new ArgumentException("亮度联动校准数据无效。");
        }
    }

    public int MapToTarget(int source)
    {
        source = Math.Clamp(source, 0, 100);
        for (var i = 1; i < Points.Count; i++)
        {
            var right = Points[i];
            if (source > right.Source) continue;
            var left = Points[i - 1];
            return (int)Math.Round(left.Target + (right.Target - left.Target) *
                (source - left.Source) / (double)(right.Source - left.Source));
        }
        return Points[^1].Target;
    }

    public int MapToSource(int target, int currentSource)
    {
        target = Math.Clamp(target, Points[0].Target, Points[^1].Target);
        // Retain the current source within a plateau, including a saturated target.
        for (var i = 1; i < Points.Count; i++)
            if (Points[i - 1].Target == target && Points[i].Target == target)
            {
                var first = i - 1;
                while (i + 1 < Points.Count && Points[i + 1].Target == target) i++;
                return Math.Clamp(currentSource, Points[first].Source, Points[i].Source);
            }
        for (var i = 1; i < Points.Count; i++)
        {
            var right = Points[i];
            if (target > right.Target) continue;
            var left = Points[i - 1];
            return (int)Math.Round(left.Source + (right.Source - left.Source) *
                (target - left.Target) / (double)(right.Target - left.Target));
        }
        return Points[^1].Source;
    }

    public bool MatchesPair(IEnumerable<string> available) => available.Contains(SourceId) && available.Contains(TargetId);

    public Dictionary<string, int> Calculate(string anchor, int value, int currentSource) => anchor == SourceId
        ? new() { [SourceId] = Math.Clamp(value, 0, 100), [TargetId] = MapToTarget(value) }
        : new() { [SourceId] = MapToSource(value, currentSource), [TargetId] = Math.Clamp(value, 0, 100) };
}
