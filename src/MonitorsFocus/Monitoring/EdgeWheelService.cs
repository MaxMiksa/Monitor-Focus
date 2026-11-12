using System.Collections.Concurrent;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace MonitorsFocus.Monitoring;

// A dedicated message-loop thread keeps slow hardware and the UI out of the hook.
internal sealed class EdgeWheelService : IDisposable
{
    private sealed record Configuration(bool Top, bool Bottom, EdgeWheelTarget[] Targets, string Modifier);
    private sealed record Pending(Configuration Configuration, EdgeWheelAction Action);
    private volatile Configuration _configuration = new(false, false, [], "alt");
    private readonly ConcurrentQueue<Pending> _pending = new();
    private readonly EdgeWheelGesture _gesture = new();
    private Configuration? _gestureConfiguration;
    private readonly Action<string> _error;
    private readonly Action? _wake;
    private readonly Thread _thread;
    private readonly HookProc _callback;
    private volatile uint _threadId;
    private volatile bool _disposed;
    private int _count;
    private IntPtr _hook;
    private const uint Refresh = 0x8001;

    public EdgeWheelService(Action<string> error, Action? wake = null)
    {
        _error = error;
        _wake = wake;
        _callback = OnMouse;
        _thread = new Thread(Run) { IsBackground = true, Name = "Screen edge wheel" };
        _thread.SetApartmentState(ApartmentState.STA);
        _thread.Start();
    }

    public void Update(bool top, bool bottom, EdgeWheelTarget[] targets, string modifier = "alt")
    {
        _configuration = new(top, bottom, targets, modifier);
        if (_threadId != 0) PostThreadMessage(_threadId, Refresh, 0, 0);
    }

    public bool TryRead(out EdgeWheelAction? action)
    {
        while (_pending.TryDequeue(out var pending))
        {
            Interlocked.Decrement(ref _count);
            if (!_disposed && ReferenceEquals(pending.Configuration, _configuration))
            {
                action = pending.Action;
                return true;
            }
        }
        action = null;
        return false;
    }

    private void Run()
    {
        // Create the native queue before publishing its id, so shutdown cannot miss it.
        PeekMessage(out _, IntPtr.Zero, 0, 0, 0);
        _threadId = GetCurrentThreadId();
        try
        {
            UpdateHook();
            while (!_disposed && GetMessage(out var message, IntPtr.Zero, 0, 0) > 0)
            {
                if (message.Message == Refresh) UpdateHook();
                else { TranslateMessage(ref message); DispatchMessage(ref message); }
            }
        }
        catch (Exception ex) { _error(ex.Message); }
        finally
        {
            if (_hook != IntPtr.Zero) UnhookWindowsHookEx(_hook);
            _hook = IntPtr.Zero;
            _threadId = 0;
        }
    }

    private void UpdateHook()
    {
        _gesture.Add(null, 0, Environment.TickCount64);
        var config = _configuration;
        _gestureConfiguration = config;
        var enabled = !_disposed && (config.Top || config.Bottom) && config.Targets.Length > 0;
        if (enabled && _hook == IntPtr.Zero)
        {
            _hook = SetWindowsHookEx(14, _callback, GetModuleHandle(null), 0);
            if (_hook == IntPtr.Zero) _error(new Win32Exception(Marshal.GetLastWin32Error()).Message);
        }
        else if (!enabled && _hook != IntPtr.Zero)
        {
            UnhookWindowsHookEx(_hook);
            _hook = IntPtr.Zero;
        }
    }

    private IntPtr OnMouse(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0 && !_disposed && (message == 0x020A || message == 0x0200))
        {
            try
            {
                var input = Marshal.PtrToStructure<MouseInput>(data);
                var config = _configuration;
                if (!ReferenceEquals(_gestureConfiguration, config))
                {
                    _gesture.Add(null, 0, Environment.TickCount64);
                    _gestureConfiguration = config;
                }
                var mode = EdgeWheelGesture.Mode(Down(0x11), Down(0x10), Down(0x12), Down(0x5B) || Down(0x5C),
                    Down(1) || Down(2) || Down(4) || Down(5) || Down(6), config.Modifier);
                var target = mode.HasValue ? EdgeWheelGesture.HitTest(config.Targets, input.Point, config.Top, config.Bottom, mode.Value) : null;
                if (message == 0x0200)
                {
                    // Moving away also discards a partial high-resolution detent.
                    if (target == null) _gesture.Add(null, 0, Environment.TickCount64);
                }
                else
                {
                    if (target == null || (input.Flags & 1) != 0 || !PhysicalDisplayScope.IsConsole ||
                        Volatile.Read(ref _count) >= 128)
                    {
                        _gesture.Add(null, 0, Environment.TickCount64);
                        return CallNextHookEx(IntPtr.Zero, code, message, data);
                    }
                    var audioTarget = mode == true && !target.Value.Brightness ? ForegroundAudioTarget.Capture() : null;
                    if (mode == true && !target.Value.Brightness && audioTarget == null)
                    {
                        _gesture.Add(null, 0, Environment.TickCount64);
                        return CallNextHookEx(IntPtr.Zero, code, message, data);
                    }
                    var steps = _gesture.Add(target, (short)(input.MouseData >> 16), Environment.TickCount64,
                        mode == true, audioTarget?.Window ?? IntPtr.Zero);
                    if (steps != 0)
                    {
                        var first = Interlocked.Increment(ref _count) == 1;
                        _pending.Enqueue(new(config, new(target.Value.Brightness ? target.Value.Id : null, steps, mode == true, audioTarget)));
                        if (first) _wake?.Invoke();
                    }
                    return 1; // Do not scroll the app beneath a handled edge gesture.
                }
            }
            catch { /* Never let a managed exception escape into the native hook chain. */ }
        }
        return CallNextHookEx(IntPtr.Zero, code, message, data);
    }

    private static bool Down(int key) => (GetAsyncKeyState(key) & 0x8000) != 0;

    public void Dispose()
    {
        _disposed = true;
        if (_threadId != 0) PostThreadMessage(_threadId, 0x0012, 0, 0);
        _thread.Join();
    }

    private delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput { public Point Point; public uint MouseData, Flags, Time; public UIntPtr ExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MessageData { public IntPtr Window; public uint Message; public UIntPtr WParam; public IntPtr LParam; public uint Time; public Point Point; public uint Private; }
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int id, HookProc callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern int GetMessage(out MessageData message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out MessageData message, IntPtr window, uint min, uint max, uint remove);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MessageData message);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref MessageData message);
    [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint thread, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string? module);
}
