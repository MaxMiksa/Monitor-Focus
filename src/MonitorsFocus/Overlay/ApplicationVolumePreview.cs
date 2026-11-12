using MonitorsFocus.Monitoring;

namespace MonitorsFocus.Overlay;

// UI-only state for one target. No audio handles, timers or per-request objects.
internal sealed class ApplicationVolumePreview
{
    private readonly Queue<(long Version, int Steps)> _pending = new(4);
    private long _confirmedVersion;
    public ApplicationVolumeFeedback? Value { get; private set; }
    public int? Level { get; private set; }
    public bool CanAdd => _pending.Count < 128;

    public void Add(long version, int steps)
    {
        if (!CanAdd) throw new InvalidOperationException("操作过快，请稍后重试。");
        _pending.Enqueue((version, steps));
        if (Level is { } level) Level = Adjust(level, steps);
    }

    public bool Confirm(ApplicationVolumeFeedback value, long version)
    {
        if (version <= _confirmedVersion) return false;
        _confirmedVersion = version;
        while (_pending.TryPeek(out var input) && input.Version <= version) _pending.Dequeue();
        var level = value.Level;
        // Replay only inputs not covered by this acknowledgement, in order:
        // + at 100%, then - must still preview 98%.
        foreach (var input in _pending) level = Adjust(level, input.Steps);
        Value = value;
        Level = level;
        return true;
    }

    public void Clear()
    {
        _pending.Clear();
        _confirmedVersion = 0;
        Value = null;
        Level = null;
    }

    private static int Adjust(int level, int steps) => (int)Math.Clamp(level + (long)steps * 2, 0, 100);
}
