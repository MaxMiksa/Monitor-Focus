using System.Media;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using MonitorsFocus.Monitoring;
using static MonitorsFocus.Monitoring.CoreAudio;

internal static class ApplicationAudioChecks
{
    // Explicit opt-in: create an inaudible stream owned by this fixture, adjust
    // only its session, verify isolation/mute, and restore all fixture state.
    public static void Run()
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            var previous = GetForegroundWindow();
            try
            {
                using var window = new Form { Text = "Monitors Focus · Audio check", Width = 320, Height = 100, ShowInTaskbar = false };
                using var wave = SilentWave();
                using var player = new SoundPlayer(wave);
                window.Show();
                window.Activate();
                Application.DoEvents();
                var target = ForegroundAudioTarget.Capture();
                if (target?.ProcessId != Environment.ProcessId) throw new Exception("Audio fixture could not acquire foreground; no session changed.");
                player.PlayLooping();
                var check = Task.Run(() => Verify(target));
                while (!check.IsCompleted) { Application.DoEvents(); Thread.Sleep(10); }
                try { check.GetAwaiter().GetResult(); }
                finally { player.Stop(); }
            }
            catch (Exception ex) { failure = ex; }
            finally { if (previous != IntPtr.Zero) SetForegroundWindow(previous); }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (failure != null) throw failure;
    }

    private static void Verify(ForegroundAudioTarget target)
    {
        var deadline = Environment.TickCount64 + 3000;
        while (ApplicationVolume.Adjust(target, 0, () => false) == 0)
        {
            if (Environment.TickCount64 >= deadline) throw new Exception("Silent fixture audio session was not found.");
            Thread.Sleep(30);
        }
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        IMMDevice? device = null;
        object? manager = null;
        object? extraStream = null;
        IAudioSessionEnumerator? sessions = null;
        var retained = new List<(IAudioSessionControl Session, uint Pid, float Level, bool Muted)>();
        try
        {
            var master = SystemVolume.ProbeLevel();
            enumerator.GetDefaultAudioEndpoint(0, 1, out device);
            // A distinct, initialized but never started WASAPI stream gives the
            // fixture a second real session, without emitting sound.
            var clientId = typeof(IAudioClient).GUID;
            device.Activate(ref clientId, 23, IntPtr.Zero, out extraStream);
            var client = (IAudioClient)extraStream;
            client.GetMixFormat(out var format);
            try
            {
                var sessionId = Guid.NewGuid();
                client.Initialize(0, 0, 1_000_000, 0, format, ref sessionId);
            }
            finally { Marshal.FreeCoTaskMem(format); }
            var iid = typeof(IAudioSessionManager2).GUID;
            device.Activate(ref iid, 23, IntPtr.Zero, out manager);
            ((IAudioSessionManager2)manager).GetSessionEnumerator(out sessions);
            sessions.GetCount(out var count);
            for (var i = 0; i < count; i++)
            {
                sessions.GetSession(i, out var session);
                try
                {
                    var control = (IAudioSessionControl2)session;
                    if (control.GetProcessId(out var pid) != 0) continue;
                    var volume = (ISimpleAudioVolume)session;
                    volume.GetMasterVolume(out var level);
                    volume.GetMute(out var muted);
                    retained.Add((session, pid, level, muted));
                    session = null!;
                }
                finally { if (session != null) Marshal.ReleaseComObject(session); }
            }
            var own = retained.Where(s => s.Pid == Environment.ProcessId).ToArray();
            if (own.Length < 2) throw new Exception("Two owned fixture sessions are required to verify a single app level.");
            var context = Guid.Empty;
            try
            {
                for (var i = 0; i < own.Length; i++)
                {
                    var volume = (ISimpleAudioVolume)own[i].Session;
                    volume.SetMasterVolume(i == 0 ? 0.48f : 0.60f, ref context);
                    volume.SetMute(true, ref context);
                }
                ApplicationVolume.Adjust(target, -1, () => false, _ => throw new Exception("Canceled write produced feedback."));
                for (var i = 0; i < own.Length; i++)
                {
                    ((ISimpleAudioVolume)own[i].Session).GetMasterVolume(out var unchanged);
                    if (Math.Abs(unchanged - (i == 0 ? 0.48f : 0.60f)) > 0.0001f)
                        throw new Exception("Canceled adjustment changed an audio session.");
                }
                ApplicationVolumeFeedback? feedback = null;
                var adjustmentTime = System.Diagnostics.Stopwatch.StartNew();
                var changed = ApplicationVolume.Adjust(target, -5, () => true, value => feedback = value);
                adjustmentTime.Stop();
                if (changed < own.Length) throw new Exception("Fixture audio session was not adjusted.");
                var expectedLevel = 0.50f;
                if (feedback == null || feedback.Target != target || !feedback.Muted ||
                    feedback.Level != (int)Math.Round(expectedLevel * 100))
                    throw new Exception("Application volume feedback did not reflect the actual levels and mute state.");
                VerifyBurst(target, () =>
                {
                    foreach (var s in own) ((ISimpleAudioVolume)s.Session).SetMasterVolume(0.40f, ref context);
                });
                expectedLevel = 0.42f;
                foreach (var s in retained)
                {
                    var volume = (ISimpleAudioVolume)s.Session;
                    volume.GetMasterVolume(out var level);
                    volume.GetMute(out var muted);
                    var expected = s.Pid == Environment.ProcessId ? expectedLevel : s.Level;
                    if (Math.Abs(level - expected) > 0.005f || muted != (s.Pid == Environment.ProcessId || s.Muted))
                        throw new Exception("Application volume isolation or mute preservation failed.");
                }
                if (Math.Abs(SystemVolume.ProbeLevel() - master) > 0.0001f) throw new Exception("Endpoint master volume changed.");
                Console.WriteLine($"PASS native application audio: {own.Length} divergent fixture sessions converge to 50%; canceled writes, other sessions/master unchanged, mute preserved.");
                Console.WriteLine($"Native application adjustment and feedback: {adjustmentTime.Elapsed.TotalMilliseconds:F1} ms.");
            }
            finally
            {
                foreach (var s in own)
                {
                    ((ISimpleAudioVolume)s.Session).SetMasterVolume(s.Level, ref context);
                    ((ISimpleAudioVolume)s.Session).SetMute(s.Muted, ref context);
                }
            }
        }
        finally
        {
            foreach (var s in retained) Marshal.ReleaseComObject(s.Session);
            if (sessions != null) Marshal.ReleaseComObject(sessions);
            if (extraStream != null) Marshal.ReleaseComObject(extraStream);
            if (manager != null) Marshal.ReleaseComObject(manager);
            if (device != null) Marshal.ReleaseComObject(device);
            Marshal.ReleaseComObject(enumerator);
        }
    }

    private static void VerifyBurst(ForegroundAudioTarget target, Action externalChange)
    {
        var errors = new System.Collections.Concurrent.ConcurrentQueue<string>();
        var completed = new TaskCompletionSource<ApplicationVolumeFeedback>(TaskCreationOptions.RunContinuationsAsynchronously);
        var callbacks = 0;
        using var nextStep = new AutoResetEvent(false);
        ApplicationVolumeFeedback? received = null;
        var volume = new SystemVolume(errors.Enqueue, applicationAdjusted: (value, version) =>
        {
            Interlocked.Increment(ref callbacks);
            if (version == 41) completed.TrySetResult(value);
            if (version >= 42) { received = value; nextStep.Set(); }
        });
        try
        {
            volume.SetEnabled(true);
            var elapsed = System.Diagnostics.Stopwatch.StartNew();
            for (var i = 1; i <= 40; i++)
                if (!volume.TryAdjust(1, target, i)) throw new Exception("Burst input was dropped.");
            if (!volume.TryAdjust(-1, target, 41)) throw new Exception("Reversal input was dropped.");
            if (!completed.Task.Wait(5000)) throw new Exception("Audio burst did not complete: " + string.Join("; ", errors));
            var final = completed.Task.Result;
            if (!errors.IsEmpty || final.Level != 98 || !final.Muted) throw new Exception("Burst lost steps, clamp reversal or mute state.");
            Console.WriteLine($"PASS audio burst: 41 notches including reversal at 100%, final 98%, {callbacks} confirmed updates, {elapsed.Elapsed.TotalMilliseconds:F1} ms total.");
            var samples = new double[12];
            for (var i = 0; i < samples.Length; i++)
            {
                Thread.Sleep(35); // Independent notches: wait for each real write/feedback before sending the next.
                var started = System.Diagnostics.Stopwatch.GetTimestamp();
                if (!volume.TryAdjust(i % 2 == 0 ? -1 : 1, target, 42 + i) || !nextStep.WaitOne(3000))
                    throw new Exception("Paced audio feedback timed out.");
                samples[i] = System.Diagnostics.Stopwatch.GetElapsedTime(started).TotalMilliseconds;
                if (received?.Level != (i % 2 == 0 ? 96 : 98)) throw new Exception("Paced audio adjustment lost a notch.");
            }
            externalChange();
            if (!volume.TryAdjust(1, target, 54) || !nextStep.WaitOne(3000) || received?.Level != 42)
                throw new Exception("Cached audio did not respect an external mixer change.");
            if (!SpinWait.SpinUntil(() => volume.HasCachedApplication, 200) ||
                !SpinWait.SpinUntil(() => !volume.HasCachedApplication, 1500))
                throw new Exception("Cached audio references did not expire after stopping.");
            Array.Sort(samples);
            Console.WriteLine($"PASS 12 individual notches: median={samples[6]:F2} ms, max={samples[^1]:F2} ms; external mixer change honored, cache released after idle.");
        }
        finally { volume.DisposeAsync().AsTask().GetAwaiter().GetResult(); }
    }

    // Only the native slots needed to initialize the additional fixture stream.
    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        void Initialize(int shareMode, uint flags, long duration, long periodicity, IntPtr format, ref Guid session);
        void GetBufferSize(out uint frames);
        void GetStreamLatency(out long latency);
        void GetCurrentPadding(out uint frames);
        void IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        void GetMixFormat(out IntPtr format);
    }

    private static MemoryStream SilentWave()
    {
        var stream = new MemoryStream();
        using (var writer = new BinaryWriter(stream, Encoding.ASCII, true))
        {
            writer.Write("RIFF"u8); writer.Write(32036); writer.Write("WAVEfmt "u8); writer.Write(16);
            writer.Write((short)1); writer.Write((short)1); writer.Write(16000); writer.Write(32000);
            writer.Write((short)2); writer.Write((short)16); writer.Write("data"u8); writer.Write(32000);
            writer.Write(new byte[32000]);
        }
        stream.Position = 0;
        return stream;
    }

    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
}
