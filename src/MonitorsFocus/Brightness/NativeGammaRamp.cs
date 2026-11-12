using System.Runtime.InteropServices;
using MonitorsFocus.Monitoring;

namespace MonitorsFocus.Brightness;

internal sealed class NativeGammaRamp : IGammaRamp
{
    private readonly string _displayName;
    private IntPtr _dc;
    private readonly PhysicalDisplayScope _scope;

    public NativeGammaRamp(string displayName)
    {
        _displayName = displayName;
        _scope = new PhysicalDisplayScope(displayName);
        _dc = CreateDC("DISPLAY", displayName, null, IntPtr.Zero);
        if (_dc == IntPtr.Zero) throw new InvalidOperationException("无法打开屏幕颜色控制");
    }

    public bool IsSdr { get { _scope.Ensure(); return DisplayColorMode.IsSdr(_displayName); } }

    public ushort[] Read()
    {
        ObjectDisposedException.ThrowIf(_dc == IntPtr.Zero, this);
        var result = new ushort[768];
        if (!GetDeviceGammaRamp(_dc, result)) throw new InvalidOperationException("无法读取屏幕原色");
        return result;
    }

    public bool Write(ushort[] ramp)
    {
        ObjectDisposedException.ThrowIf(_dc == IntPtr.Zero, this);
        if (ramp.Length != 768) throw new ArgumentException("屏幕颜色数据长度无效。", nameof(ramp));
        _scope.Ensure();
        return SetDeviceGammaRamp(_dc, ramp);
    }

    public void Dispose()
    {
        if (_dc != IntPtr.Zero) DeleteDC(_dc);
        _dc = IntPtr.Zero;
    }

    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateDC(string driver, string device, string? output, IntPtr init);
    [DllImport("gdi32.dll")]
    private static extern bool GetDeviceGammaRamp(IntPtr dc, [Out] ushort[] ramp);
    [DllImport("gdi32.dll")]
    private static extern bool SetDeviceGammaRamp(IntPtr dc, ushort[] ramp);
    [DllImport("gdi32.dll")]
    private static extern bool DeleteDC(IntPtr dc);
}

internal static class DisplayColorMode
{
    // Query the current source-to-target mapping; display numbers can change after reconnect.
    public static bool IsSdr(string displayName) => ReadMode(displayName)?.IsSdr == true;
    public static bool IsInternal(string displayName) => ReadMode(displayName)?.IsInternal == true;

    private readonly record struct DisplayMode(bool IsSdr, bool IsInternal);

    private static DisplayMode? ReadMode(string displayName)
    {
        for (var attempt = 0; attempt < 3; attempt++)
        {
            if (GetDisplayConfigBufferSizes(2, out var pathCount, out var modeCount) != 0) return null;
            var paths = new PathInfo[pathCount];
            var modes = new ModeInfo[modeCount];
            var status = QueryDisplayConfig(2, ref pathCount, paths, ref modeCount, modes, IntPtr.Zero);
            if (status == 122) continue;
            if (status != 0) return null;
            var matches = 0;
            DisplayMode? result = null;
            foreach (var path in paths.AsSpan(0, (int)pathCount))
            {
                var source = new SourceName
                {
                    Header = new Header { Type = 1, Size = (uint)Marshal.SizeOf<SourceName>(), Adapter = path.SourceAdapter, Id = path.SourceId }
                };
                if (GetSourceName(ref source) != 0) return null;
                if (!string.Equals(source.Name, displayName, StringComparison.OrdinalIgnoreCase)) continue;
                if (++matches > 1) return null; // Cloned targets share a source; independent color is not guaranteed.
                var color = new ColorInfo
                {
                    Header = new Header { Type = 9, Size = (uint)Marshal.SizeOf<ColorInfo>(), Adapter = path.TargetAdapter, Id = path.TargetId }
                };
                if (GetColorInfo(ref color) != 0) return null;
                result = new((color.Flags & 2) == 0, path.OutputTechnology is 6 or 11 or 13 or 0x80000000);
            }
            return matches == 1 ? result : null;
        }
        return null;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Luid { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Header { public uint Type, Size; public Luid Adapter; public uint Id; }
    [StructLayout(LayoutKind.Explicit, Size = 72)]
    private struct PathInfo
    {
        [FieldOffset(0)] public Luid SourceAdapter;
        [FieldOffset(8)] public uint SourceId;
        [FieldOffset(20)] public Luid TargetAdapter;
        [FieldOffset(28)] public uint TargetId;
        [FieldOffset(36)] public uint OutputTechnology;
    }
    [StructLayout(LayoutKind.Explicit, Size = 64)]
    private struct ModeInfo { }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SourceName
    {
        public Header Header;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Name;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ColorInfo { public Header Header; public uint Flags, Encoding, BitsPerChannel; }

    [DllImport("user32.dll")]
    private static extern int GetDisplayConfigBufferSizes(uint flags, out uint paths, out uint modes);
    [DllImport("user32.dll")]
    private static extern int QueryDisplayConfig(uint flags, ref uint paths, [Out] PathInfo[] pathData,
        ref uint modes, [Out] ModeInfo[] modeData, IntPtr topology);
    [DllImport("user32.dll", EntryPoint = "DisplayConfigGetDeviceInfo")]
    private static extern int GetSourceName(ref SourceName info);
    [DllImport("user32.dll", EntryPoint = "DisplayConfigGetDeviceInfo")]
    private static extern int GetColorInfo(ref ColorInfo info);
}
