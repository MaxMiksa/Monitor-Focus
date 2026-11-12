namespace MonitorsFocus.Brightness;

internal interface IGammaRamp : IDisposable
{
    bool IsSdr { get; }
    ushort[] Read();
    bool Write(ushort[] ramp);
}

internal sealed class GammaColorDevice : ITemperatureDevice
{
    private readonly IGammaRamp _ramp;
    private ushort[]? _baseline;
    private ushort[]? _written;

    internal GammaColorDevice(IGammaRamp ramp) => _ramp = ramp;

    public static GammaColorDevice? Open(string displayName, out string? error)
    {
        error = null;
        NativeGammaRamp? ramp = null;
        try
        {
            ramp = new NativeGammaRamp(displayName);
            if (!ramp.IsSdr) throw new InvalidOperationException("HDR 或高级颜色模式下暂不调色");
            _ = ramp.Read();
            return new GammaColorDevice(ramp);
        }
        catch (Exception ex) { ramp?.Dispose(); error = ex.Message; return null; }
    }

    public void Apply(int? kelvin)
    {
        if (!kelvin.HasValue || kelvin.Value >= 6500) { Restore(); return; }
        if (!_ramp.IsSdr) throw new InvalidOperationException("HDR 或高级颜色模式下暂不调色");
        var current = _ramp.Read();
        if (_written != null && !current.AsSpan().SequenceEqual(_written) &&
            !current.AsSpan().SequenceEqual(_baseline))
        {
            _written = null;
            _baseline = null;
            throw new InvalidOperationException("颜色已被其他程序更改，已停止调色；请重新检测后重试");
        }
        if (_written == null) _baseline = current;
        var target = WarmRamp(_baseline ?? current, kelvin.Value);
        if (current.AsSpan().SequenceEqual(target)) return;
        // Record ownership before the call: a driver can change state even when it reports failure.
        _written = target;
        if (!_ramp.Write(target) || !_ramp.Read().AsSpan().SequenceEqual(target))
            throw new InvalidOperationException("屏幕未接受色温设置，请检查夜间模式或其他调色软件");
    }

    internal static ushort[] WarmRamp(ushort[] baseline, int kelvin)
    {
        if (baseline.Length != 768) throw new ArgumentException("屏幕颜色数据长度无效。", nameof(baseline));
        // Approximate Kelvin-to-RGB, normalized to leave the user's 6500 K baseline untouched.
        // This is a warmth control, not a measured colorimetric calibration.
        var temperature = Math.Clamp(kelvin, 2700, 6500) / 100.0;
        var green = (99.4708025861 * Math.Log(temperature) - 161.1195681661) /
            (99.4708025861 * Math.Log(65) - 161.1195681661);
        var blue = (138.5177312231 * Math.Log(temperature - 10) - 305.0447927307) /
            (138.5177312231 * Math.Log(55) - 305.0447927307);
        // GDI restricts every entry to within 32768 of identity. Compress warmth uniformly
        // into that range, preserving channel proportions instead of clipping the curve.
        var blend = 1.0;
        for (var i = 1; i < 256; i++)
        {
            var lower = Math.Max(0, i * 257 - 32767);
            if (green < 1 && baseline[256 + i] > 0)
                blend = Math.Min(blend, (1 - lower / (double)baseline[256 + i]) / (1 - green));
            if (blue < 1 && baseline[512 + i] > 0)
                blend = Math.Min(blend, (1 - lower / (double)baseline[512 + i]) / (1 - blue));
        }
        if (blend <= 0) throw new InvalidOperationException("现有颜色校准超出系统调色范围，暂不调色");
        green = 1 - (1 - green) * blend;
        blue = 1 - (1 - blue) * blend;
        var result = (ushort[])baseline.Clone();
        for (var i = 0; i < 256; i++)
        {
            result[256 + i] = (ushort)Math.Round(baseline[256 + i] * green);
            result[512 + i] = (ushort)Math.Round(baseline[512 + i] * blue);
        }
        return result;
    }

    private void Restore()
    {
        if (_written == null || _baseline == null) { _baseline = null; return; }
        // Never overwrite a newer adjustment made by the system or another color tool.
        if (_ramp.IsSdr && _ramp.Read().AsSpan().SequenceEqual(_written))
        {
            if (!_ramp.Write(_baseline) || !_ramp.Read().AsSpan().SequenceEqual(_baseline))
                throw new InvalidOperationException("恢复原色失败，请重新检测显示器");
        }
        _written = null;
        _baseline = null;
    }

    public void Dispose()
    {
        try { Restore(); }
        finally { _ramp.Dispose(); }
    }
}
