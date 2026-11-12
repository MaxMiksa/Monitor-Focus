using System.Runtime.InteropServices;
using System.Threading.Channels;

namespace MonitorsFocus.Monitoring;

internal enum HardwareOsd { Volume = 0, Brightness = 3 }

// The shell owns the visual, value, placement and timeout. This private interface is
// best effort: never synthesize media keys or change hardware to make an OSD appear.
internal sealed class NativeHardwareOsd : IAsyncDisposable
{
    private readonly Channel<(HardwareOsd Kind, int Generation)> _requests =
        Channel.CreateBounded<(HardwareOsd, int)>(new BoundedChannelOptions(1)
        { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true });
    private readonly Task _worker;
    private int _enabled;
    private int _generation;

    public NativeHardwareOsd(Action<string> error, Action<HardwareOsd>? show = null, Func<bool>? canShow = null)
    {
        _worker = Task.Run(async () =>
        {
            long nextError = 0;
            await foreach (var request in _requests.Reader.ReadAllAsync())
            {
                if (request.Generation != Volatile.Read(ref _generation) ||
                    (Volatile.Read(ref _enabled) & (1 << (int)request.Kind)) == 0 ||
                    !(canShow?.Invoke() ?? PhysicalDisplayScope.IsConsole)) continue;
                try { (show ?? Show)(request.Kind); }
                catch (Exception ex)
                {
                    if (Environment.TickCount64 < nextError) continue;
                    nextError = Environment.TickCount64 + 5000;
                    error(ex.Message);
                }
            }
        });
    }

    public void SetEnabled(bool brightness, bool volume)
    {
        var enabled = (brightness ? 1 << (int)HardwareOsd.Brightness : 0) |
            (volume ? 1 << (int)HardwareOsd.Volume : 0);
        if (Volatile.Read(ref _enabled) == enabled) return;
        Interlocked.Increment(ref _generation);
        Volatile.Write(ref _enabled, enabled);
    }

    public void Request(HardwareOsd kind) => _requests.Writer.TryWrite((kind, Volatile.Read(ref _generation)));

    public async ValueTask DisposeAsync()
    {
        SetEnabled(false, false);
        _requests.Writer.TryComplete();
        await _worker;
    }

    private static void Show(HardwareOsd kind)
    {
        object? shell = null;
        IFlyoutDisplay? display = null;
        try
        {
            shell = new ImmersiveShell();
            var service = typeof(IFlyoutDisplay).GUID;
            var iid = service;
            Marshal.ThrowExceptionForHR(((IServiceProvider)shell).QueryService(ref service, ref iid, out display));
            Marshal.ThrowExceptionForHR(display.ShowFlyout((int)kind, 0));
        }
        finally
        {
            if (display != null) Marshal.ReleaseComObject(display);
            if (shell != null) Marshal.ReleaseComObject(shell);
        }
    }

    [ComImport, Guid("C2F03A33-21F5-47FA-B4BB-156362A2F239")]
    private class ImmersiveShell { }

    [ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IServiceProvider
    {
        [PreserveSig] int QueryService(ref Guid service, ref Guid iid, out IFlyoutDisplay display);
    }

    [ComImport, Guid("41F9D2FB-7834-4AB6-8B1B-73E74064B465"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFlyoutDisplay
    {
        [PreserveSig] int ShowFlyout(int kind, uint flags);
    }
}
