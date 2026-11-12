using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using static MonitorsFocus.Monitoring.CoreAudio;

namespace MonitorsFocus.Monitoring;

internal sealed record ApplicationVolumeFeedback(ForegroundAudioTarget Target, string Name, int Level, bool Muted);

// Created, used and disposed exclusively on the audio MTA worker.
internal sealed class ApplicationVolume : IDisposable
{
    internal const int IdleMilliseconds = 500;
    private readonly List<(IAudioSessionControl Session, SafeProcessHandle Process)> _sessions = new();
    private readonly Dictionary<uint, SafeProcessHandle> _processes = new();
    private ForegroundAudioTarget? _target;
    private string _name = "";
    private long _openedAt;
    private long _lastAt;

    internal int IdleRemaining => _target == null ? 0 : (int)Math.Clamp(IdleMilliseconds - (Environment.TickCount64 - _lastAt), 0, IdleMilliseconds);
    internal bool HasTarget => _target != null;
    internal static float TargetLevel(float current, int steps) => Math.Clamp(current + steps * 0.02f, 0, 1);

    // One-shot entry for read-only probes and the native fixture.
    public static int Adjust(ForegroundAudioTarget target, int steps, Func<bool> canWrite, Action<ApplicationVolumeFeedback>? adjusted = null)
    {
        using var volume = new ApplicationVolume();
        return volume.Apply(target, steps, canWrite, adjusted);
    }

    public int Apply(ForegroundAudioTarget target, int steps, Func<bool> canWrite, Action<ApplicationVolumeFeedback>? adjusted = null)
    {
        try
        {
            if (!target.IsCurrent || !PhysicalDisplayScope.IsConsole || (steps != 0 && !canWrite()))
            {
                Clear();
                return 0;
            }
            if (_target?.Window != target.Window || _target?.ProcessId != target.ProcessId || IdleRemaining == 0 ||
                Environment.TickCount64 - _openedAt >= 1000 || _processes.Values.Any(p => !ForegroundAudioTarget.IsAlive(p)))
            {
                Clear();
                Discover(target);
            }
            var count = _sessions.Count;
            if (count == 0)
            {
                Clear();
                if (steps != 0 && canWrite() && target.IsCurrent)
                    throw new InvalidOperationException("当前软件没有可调节的音频会话，请先播放音频。");
                return 0;
            }
            _lastAt = Environment.TickCount64;
            if (steps == 0) return count;

            // Read the live scalar: mixer changes must take effect even while
            // the session references are being reused.
            var current = 0f;
            foreach (var item in _sessions)
            {
                item.Session.GetState(out var state);
                if (state == 2) throw new InvalidOperationException("应用音频会话已失效。");
                ((ISimpleAudioVolume)item.Session).GetMasterVolume(out var value);
                current = Math.Max(current, value);
            }
            var level = TargetLevel(current, steps);
            var actualLevel = 0;
            var allMuted = true;
            Exception? failure = null;
            foreach (var item in _sessions)
            {
                if (!canWrite() || !PhysicalDisplayScope.IsConsole || !target.IsCurrent ||
                    !ForegroundAudioTarget.IsAlive(_processes[target.ProcessId]) || !ForegroundAudioTarget.IsAlive(item.Process))
                {
                    Clear();
                    return count;
                }
                try
                {
                    var volume = (ISimpleAudioVolume)item.Session;
                    var context = Guid.Empty;
                    volume.SetMasterVolume(level, ref context); // Preserve mute and endpoint master.
                    volume.GetMasterVolume(out var actual);
                    if (Math.Abs(actual - level) > 0.005f) throw new InvalidOperationException("应用音量写入未生效。");
                    volume.GetMute(out var muted);
                    actualLevel = (int)Math.Round(actual * 100);
                    allMuted &= muted;
                }
                catch (Exception ex) { failure ??= ex; }
            }
            if (failure != null) throw new InvalidOperationException("部分应用音量调节失败，其他会话可能已调整。", failure);
            _lastAt = Environment.TickCount64;
            if (canWrite() && target.IsCurrent) adjusted?.Invoke(new(target, _name, actualLevel, allMuted));
            return count;
        }
        catch { Clear(); throw; }
    }

    private void Discover(ForegroundAudioTarget target)
    {
        var processes = target.ResolveProcesses();
        if (!processes.TryGetValue(target.ProcessId, out var root)) return;
        _processes.Add(root.Id, ForegroundAudioTarget.Pin(root));
        IMMDeviceEnumerator? enumerator = null;
        IMMDeviceCollection? devices = null;
        Exception? failure = null;
        try
        {
            enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            enumerator.EnumAudioEndpoints(0, 1, out devices);
            devices.GetCount(out var count);
            for (uint i = 0; i < count; i++)
            {
                IMMDevice? device = null;
                object? manager = null;
                IAudioSessionEnumerator? sessions = null;
                try
                {
                    devices.Item(i, out device);
                    var iid = typeof(IAudioSessionManager2).GUID;
                    device.Activate(ref iid, 23, IntPtr.Zero, out manager);
                    ((IAudioSessionManager2)manager).GetSessionEnumerator(out sessions);
                    sessions.GetCount(out var sessionCount);
                    for (var j = 0; j < sessionCount; j++)
                    {
                        IAudioSessionControl? session = null;
                        try
                        {
                            sessions.GetSession(j, out session);
                            var control = (IAudioSessionControl2)session;
                            if (control.GetProcessId(out var pid) != 0 || pid == 0 ||
                                !ForegroundAudioTarget.BelongsTo(pid, target.ProcessId, processes)) continue;
                            control.GetState(out var state);
                            if (state == 2 || control.IsSystemSoundsSession() != 1) continue;
                            if (!target.IsCurrent) { Clear(); return; }
                            if (!_processes.TryGetValue(pid, out var process))
                            {
                                process = ForegroundAudioTarget.Pin(processes[pid]);
                                _processes.Add(pid, process);
                            }
                            _sessions.Add((session, process));
                            session = null;
                        }
                        catch (Exception ex) { failure ??= ex; }
                        finally { if (session != null) Marshal.ReleaseComObject(session); }
                    }
                }
                catch (Exception ex) { failure ??= ex; }
                finally
                {
                    if (sessions != null) Marshal.ReleaseComObject(sessions);
                    if (manager != null) Marshal.ReleaseComObject(manager);
                    if (device != null) Marshal.ReleaseComObject(device);
                }
            }
            if (failure != null) throw new InvalidOperationException("无法读取应用音频会话。", failure);
            _target = target;
            _name = root.Name;
            _openedAt = _lastAt = Environment.TickCount64;
        }
        finally
        {
            if (devices != null) Marshal.ReleaseComObject(devices);
            if (enumerator != null) Marshal.ReleaseComObject(enumerator);
        }
    }

    public void Clear()
    {
        foreach (var item in _sessions) Marshal.ReleaseComObject(item.Session);
        _sessions.Clear();
        foreach (var process in _processes.Values) process.Dispose();
        _processes.Clear();
        _target = null;
        _name = "";
    }

    public void Dispose() => Clear();
}
