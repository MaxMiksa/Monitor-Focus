using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace MonitorsFocus.Monitoring;

internal sealed record AudioProcess(uint Id, uint ParentId, string Name, long StartedAt = 0);

internal sealed record ForegroundAudioTarget(IntPtr Window, uint ProcessId, long CapturedAt)
{
    // Hook-safe: capture identity only; process inspection and audio calls happen later.
    public static ForegroundAudioTarget? Capture()
    {
        var window = GetForegroundWindow();
        GetWindowThreadProcessId(window, out var process);
        return window == IntPtr.Zero || process == 0 ? null : new(window, process, DateTime.UtcNow.Ticks);
    }

    public bool IsCurrent => GetForegroundWindow() == Window &&
        GetWindowThreadProcessId(Window, out var process) != 0 && process == ProcessId;

    internal static bool BelongsTo(uint candidate, uint foreground, IReadOnlyDictionary<uint, AudioProcess> processes)
    {
        if (!processes.TryGetValue(foreground, out var root) || !processes.TryGetValue(candidate, out var member)) return false;
        // Chromium audio lives in a child process; never group unrelated instances
        // merely because their executables have the same name.
        var visited = new HashSet<uint>();
        while (visited.Add(root.Id) && processes.TryGetValue(root.ParentId, out var parent) &&
            string.Equals(root.Name, parent.Name, StringComparison.OrdinalIgnoreCase) && parent.StartedAt <= root.StartedAt)
            root = parent;
        if (!string.Equals(member.Name, root.Name, StringComparison.OrdinalIgnoreCase)) return false;
        visited.Clear();
        while (visited.Add(member.Id))
        {
            if (member.Id == root.Id) return true;
            if (!processes.TryGetValue(member.ParentId, out var parent) || parent.StartedAt > member.StartedAt) return false;
            member = parent;
        }
        return false;
    }

    public Dictionary<uint, AudioProcess> ResolveProcesses()
    {
        using var foreground = Process.GetProcessById((int)ProcessId);
        if (!IsCurrent || foreground.StartTime.ToUniversalTime().Ticks > CapturedAt) return [];
        var name = foreground.ProcessName;
        var session = foreground.SessionId;
        var processes = new Dictionary<uint, AudioProcess>();
        var snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>() };
            if (!Process32First(snapshot, ref entry)) throw new Win32Exception(Marshal.GetLastWin32Error());
            do
            {
                // Restrict lifetime inspection to this executable. A launched
                // player/editor is a separate application even if it is a descendant.
                if (!string.Equals(Path.GetFileNameWithoutExtension(entry.ExeFile), name, StringComparison.OrdinalIgnoreCase)) continue;
                try
                {
                    using var process = Process.GetProcessById((int)entry.ProcessId);
                    var started = process.StartTime.ToUniversalTime().Ticks;
                    if (process.SessionId == session && started <= CapturedAt &&
                        string.Equals(process.ProcessName, name, StringComparison.OrdinalIgnoreCase))
                        processes[entry.ProcessId] = new(entry.ProcessId, entry.ParentId, name, started);
                }
                catch (ArgumentException) { /* A process exited during enumeration. */ }
                catch (Win32Exception) { /* Inaccessible processes cannot be safely controlled. */ }
                catch (InvalidOperationException) { }
            } while (Process32Next(snapshot, ref entry));
        }
        finally { CloseHandle(snapshot); }
        return processes;
    }

    public static bool StillMatches(AudioProcess expected)
    {
        try
        {
            using var process = Process.GetProcessById((int)expected.Id);
            return process.StartTime.ToUniversalTime().Ticks == expected.StartedAt &&
                string.Equals(process.ProcessName, expected.Name, StringComparison.OrdinalIgnoreCase);
        }
        catch (ArgumentException) { return false; }
        catch (Win32Exception) { return false; }
        catch (InvalidOperationException) { return false; }
    }

    // Keep a small set of verified handles only for the current scrolling burst.
    internal static SafeProcessHandle Pin(AudioProcess expected)
    {
        var handle = OpenProcess(0x101000, false, expected.Id);
        try
        {
            if (handle.IsInvalid || !GetProcessTimes(handle, out var created, out _, out _, out _))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (DateTime.FromFileTimeUtc(created).Ticks != expected.StartedAt)
                throw new InvalidOperationException("应用音频会话已失效。");
            return handle;
        }
        catch { handle.Dispose(); throw; }
    }

    internal static bool IsAlive(SafeProcessHandle handle) => WaitForSingleObject(handle, 0) == 0x102;

    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(SafeProcessHandle process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        public uint Size, Usage, ProcessId;
        public UIntPtr DefaultHeap;
        public uint Module, Threads, ParentId;
        public int Priority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string ExeFile;
    }
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint process);
    [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", EntryPoint = "Process32NextW", CharSet = CharSet.Unicode)] private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}
