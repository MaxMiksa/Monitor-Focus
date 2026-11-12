using System.Diagnostics;
using System.Runtime.InteropServices;

namespace MonitorsFocus.Monitoring;

// Only the interactive physical-console session may own hardware controls.
internal sealed class PhysicalDisplayScope
{
    private static readonly uint Session = (uint)Process.GetCurrentProcess().SessionId;
    private readonly string _displayName;
    private readonly string? _identity;
    public static bool IsConsole => Session == WTSGetActiveConsoleSessionId();

    public PhysicalDisplayScope(string displayName)
    {
        _displayName = displayName;
        _identity = DisplayIdentity.FindInstance(displayName);
        Ensure();
    }

    internal static bool Matches(uint session, uint console, string? expected, string? actual) =>
        console != uint.MaxValue && session == console && !string.IsNullOrEmpty(expected) &&
        string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase);

    public void Ensure()
    {
        if (!Matches(Session, WTSGetActiveConsoleSessionId(), _identity, DisplayIdentity.FindInstance(_displayName)))
            throw new InvalidOperationException("前台屏幕绑定已变化，已停止控制；请重新检测");
    }

    public static void EnsureClient(IntPtr pipe)
    {
        if (!IsConsole || !GetNamedPipeClientProcessId(pipe, out var process) ||
            !ProcessIdToSessionId(process, out var session) || session != Session)
            throw new InvalidOperationException("仅允许前台会话控制实体屏幕");
    }

    [DllImport("kernel32.dll")] private static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("kernel32.dll")] private static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint process);
    [DllImport("kernel32.dll")] private static extern bool ProcessIdToSessionId(uint process, out uint session);
}
