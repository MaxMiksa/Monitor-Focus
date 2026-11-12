namespace MonitorsFocus.Monitoring;

internal sealed record EdgeWheelTarget(string Id, Rectangle Bounds, bool Brightness, bool Temperature = false);
internal sealed record EdgeWheelAction(string? DisplayId, int Steps, bool Alternate = false, ForegroundAudioTarget? AudioTarget = null);

// All coordinates are physical desktop pixels, including negative monitor origins.
internal sealed class EdgeWheelGesture
{
    private (string, bool)? _target;
    private int _remainder;
    private long _lastAt;
    private bool _alternate;
    private IntPtr _foreground;

    internal static bool? Mode(bool control, bool shift, bool alt, bool windows, bool buttons, string modifier = "alt")
    {
        if (windows || buttons) return null;
        var selected = modifier switch { "alt" => alt, "ctrl" => control, "shift" => shift, _ => (bool?)null };
        if (!selected.HasValue) return null;
        var count = (control ? 1 : 0) + (shift ? 1 : 0) + (alt ? 1 : 0);
        return count == 0 ? false : count == 1 && selected.Value ? true : null;
    }

    public static (string Id, bool Brightness)? HitTest(EdgeWheelTarget[] targets, Point point,
        bool topEnabled, bool bottomEnabled, bool alternate = false)
    {
        foreach (var target in targets)
        {
            if (!target.Bounds.Contains(point)) continue;
            if (topEnabled && (alternate ? target.Temperature : target.Brightness) && point.Y == target.Bounds.Top) return (target.Id, true);
            if (bottomEnabled && point.Y == target.Bounds.Bottom - 1) return (target.Id, false);
            break;
        }
        return null;
    }

    public int Add((string Id, bool Brightness)? target, int delta, long now, bool alternate = false, IntPtr foreground = default)
    {
        if (target == null || target != _target || alternate != _alternate || foreground != _foreground || now - _lastAt > 500) _remainder = 0;
        _target = target;
        _alternate = alternate;
        _foreground = foreground;
        _lastAt = now;
        if (target == null) return 0;
        _remainder += delta;
        var steps = _remainder / 120;
        _remainder %= 120;
        return steps;
    }
}
