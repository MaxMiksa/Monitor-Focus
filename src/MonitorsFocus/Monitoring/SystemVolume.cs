using System.Runtime.InteropServices;
using System.Threading.Channels;
using static MonitorsFocus.Monitoring.CoreAudio;

namespace MonitorsFocus.Monitoring;

internal sealed class SystemVolume : IAsyncDisposable
{
    internal readonly record struct Request(int Generation, int Steps, ForegroundAudioTarget? Target, long Feedback);
    private readonly Channel<Request> _requests = Channel.CreateBounded<Request>(128);
    private readonly Task _worker;
    private volatile bool _enabled;
    private int _generation;
    private int _applicationCached;
    internal bool HasCachedApplication => Volatile.Read(ref _applicationCached) != 0;

    public SystemVolume(Action<string> error, Action? adjusted = null, Action<ApplicationVolumeFeedback, long>? applicationAdjusted = null)
    {
        var completed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _worker = completed.Task;
        var thread = new Thread(() =>
        {
            try
            {
                using var application = new ApplicationVolume();
                var cacheGeneration = 0;
                void ClearApplication()
                {
                    application.Clear();
                    Volatile.Write(ref _applicationCached, 0);
                    cacheGeneration = Volatile.Read(ref _generation);
                }
                while (true)
                {
                    if (cacheGeneration != Volatile.Read(ref _generation)) ClearApplication();
                    var available = _requests.Reader.WaitToReadAsync();
                    if (!available.IsCompletedSuccessfully)
                    {
                        var pending = available.AsTask();
                        if (application.HasTarget && !pending.Wait(application.IdleRemaining)) ClearApplication();
                        // Reuse the same pending read after timeout; do not leave
                        // abandoned tasks/timers or poll while idle.
                        if (!pending.GetAwaiter().GetResult()) break;
                    }
                    else if (!available.GetAwaiter().GetResult()) break;

                    while (_requests.Reader.TryRead(out var request))
                    {
                        while (_requests.Reader.TryPeek(out var next) && CanMerge(request, next) && _requests.Reader.TryRead(out next))
                            request = request with { Steps = request.Steps + next.Steps, Feedback = next.Feedback };
                        if (request.Steps == 0 || cacheGeneration != Volatile.Read(ref _generation)) ClearApplication();
                        if (request.Steps == 0 || !_enabled || request.Generation != Volatile.Read(ref _generation) || !PhysicalDisplayScope.IsConsole) continue;
                        try
                        {
                            bool CanWrite() => _enabled && request.Generation == Volatile.Read(ref _generation) && PhysicalDisplayScope.IsConsole;
                            if (request.Target != null)
                            {
                                cacheGeneration = request.Generation;
                                application.Apply(request.Target, request.Steps, CanWrite,
                                    feedback => { if (CanWrite()) applicationAdjusted?.Invoke(feedback, request.Feedback); });
                                Volatile.Write(ref _applicationCached, application.HasTarget ? 1 : 0);
                            }
                            else
                            {
                                ClearApplication();
                                Adjust(request.Steps, CanWrite);
                                if (CanWrite()) adjusted?.Invoke();
                            }
                        }
                        catch (Exception ex) { ClearApplication(); error(ex.Message); }
                    }
                }
                ClearApplication();
            }
            catch (Exception ex) { completed.TrySetException(ex); return; }
            completed.TrySetResult();
        }) { IsBackground = true, Name = "Audio volume" };
        thread.SetApartmentState(ApartmentState.MTA);
        thread.Start();
    }

    internal static bool CanMerge(Request first, Request next) =>
        first.Generation == next.Generation && Math.Sign(first.Steps) == Math.Sign(next.Steps) &&
        first.Target?.Window == next.Target?.Window && first.Target?.ProcessId == next.Target?.ProcessId;

    public void SetEnabled(bool enabled)
    {
        // A configuration refresh also cancels requests from the previous modifier.
        Interlocked.Increment(ref _generation);
        _enabled = enabled;
        _requests.Writer.TryWrite(new(Volatile.Read(ref _generation), 0, null, 0));
    }

    public bool TryAdjust(int steps, ForegroundAudioTarget? target = null, long feedback = 0) =>
        _enabled && _requests.Writer.TryWrite(new(Volatile.Read(ref _generation), steps, target, feedback));

    internal static float ProbeLevel() => Adjust(0, static () => false);

    private static float Adjust(int steps, Func<bool> canWrite)
    {
        IMMDeviceEnumerator? enumerator = null;
        IMMDevice? device = null;
        IAudioEndpointVolume? volume = null;
        try
        {
            enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            enumerator.GetDefaultAudioEndpoint(0, 1, out device); // render / multimedia
            var iid = typeof(IAudioEndpointVolume).GUID;
            device.Activate(ref iid, 23, IntPtr.Zero, out var instance);
            volume = (IAudioEndpointVolume)instance;
            volume.GetMasterVolumeLevelScalar(out var current);
            var target = Math.Clamp(current + steps * 0.02f, 0, 1);
            var context = Guid.Empty;
            if (Math.Abs(target - current) > 0.00001f && canWrite() && PhysicalDisplayScope.IsConsole)
                volume.SetMasterVolumeLevelScalar(target, ref context);
            return current;
        }
        finally
        {
            if (volume != null) Marshal.ReleaseComObject(volume);
            if (device != null) Marshal.ReleaseComObject(device);
            if (enumerator != null) Marshal.ReleaseComObject(enumerator);
        }
    }

    public async ValueTask DisposeAsync()
    {
        SetEnabled(false);
        _requests.Writer.TryComplete();
        await _worker;
    }

}
