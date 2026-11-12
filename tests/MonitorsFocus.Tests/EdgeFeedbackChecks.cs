using System.Diagnostics;
using System.Drawing;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using MonitorsFocus.Overlay;

internal static class EdgeFeedbackChecks
{
    // Explicit UI/resource check; never writes monitor or audio settings.
    public static void Run(string? captureDirectory)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try { Verify(captureDirectory); }
            catch (Exception ex) { failure = ex; }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (failure != null) throw failure;
    }

    private static void Verify(string? captureDirectory)
    {
        var foreground = GetForegroundWindow();
        using var process = Process.GetCurrentProcess();
        var privateBefore = process.PrivateMemorySize64;
        var initialGdi = GetGuiResources(process.Handle, 0);
        var warmedGdi = initialGdi;
        var area = Screen.PrimaryScreen!.WorkingArea;
        using (var form = new EdgeFeedbackForm())
        {
            var monitor = MonitorFromPoint(new Point(area.Left, area.Top), 2);
            GetDpiForMonitor(monitor, 0, out var dpi, out _);
            form.Present(EdgeFeedback.Color("色温", 4200), area, (int)dpi);
            Application.DoEvents();
            form.Refresh();
            var handle = form.Handle;
            if (GetForegroundWindow() != foreground) throw new Exception("Feedback stole foreground focus.");
            var styles = GetWindowLongPtr(handle, -20).ToInt64();
            if ((styles & 0x080800A0) != 0x080800A0) throw new Exception("Feedback is missing no-activate/click-through/tool-window/layered styles.");
            Capture("temperature");
            form.Present(EdgeFeedback.Volume("浏览器", 50, false, "静音"), area, (int)dpi);
            Application.DoEvents(); form.Refresh(); Capture("application-volume");
            for (var i = 0; i < 30; i++)
            {
                form.Present(EdgeFeedback.Color("色温", 4000 + i * 100), area, (int)dpi);
                Application.DoEvents(); form.Refresh();
            }
            form.Dismiss();
            Application.DoEvents();
            var managedBefore = GC.GetTotalMemory(true);
            process.Refresh();
            var warmedPrivate = process.PrivateMemorySize64;
            var gdiBefore = GetGuiResources(process.Handle, 0);
            warmedGdi = gdiBefore;
            var userBefore = GetGuiResources(process.Handle, 1);
            for (var i = 0; i < 2000; i++)
            {
                form.Present(EdgeFeedback.Volume("Browser", i % 101, i % 3 == 0, "Muted"), area, (int)dpi);
                Application.DoEvents(); form.Refresh();
            }
            if (form.Handle != handle) throw new Exception("Feedback recreated its window during scrolling.");
            var until = Environment.TickCount64 + 2300;
            while (form.Visible && Environment.TickCount64 < until) { Application.DoEvents(); Thread.Sleep(20); }
            var timer = (System.Windows.Forms.Timer)typeof(EdgeFeedbackForm).GetField("_hide", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(form)!;
            if (form.Visible || timer.Enabled) throw new Exception("Feedback or its timer remained active after the timeout.");
            var retained = GC.GetTotalMemory(true) - managedBefore;
            process.Refresh();
            var gdiAfter = GetGuiResources(process.Handle, 0);
            var userAfter = GetGuiResources(process.Handle, 1);
            if (gdiAfter > gdiBefore + 2 || userAfter > userBefore + 2 || retained > 256 * 1024)
                throw new Exception($"Feedback resources grew: managed={retained}; GDI={gdiAfter - gdiBefore}; USER={userAfter - userBefore}.");
            Console.WriteLine($"PASS feedback: one reused HWND; no focus theft; auto-hide stops timer; 2000 paints: retained managed delta={retained} B, private delta={process.PrivateMemorySize64 - warmedPrivate} B, GDI delta={gdiAfter - gdiBefore}, USER delta={userAfter - userBefore}.");
            Console.WriteLine($"First-use process private delta (includes WinForms/font/GDI initialization): {warmedPrivate - privateBefore} B.");
            var privateAfterFirstBatch = process.PrivateMemorySize64;
            for (var i = 0; i < 2000; i++)
            {
                form.Present(EdgeFeedback.Volume("Browser", i % 101, false, "Muted"), area, (int)dpi);
                Application.DoEvents(); form.Refresh();
            }
            form.Dismiss(); Application.DoEvents();
            GC.GetTotalMemory(true); process.Refresh();
            Console.WriteLine($"Additional 2000 paints after warm-up: private delta={process.PrivateMemorySize64 - privateAfterFirstBatch} B; GDI delta={GetGuiResources(process.Handle, 0) - gdiBefore}; USER delta={GetGuiResources(process.Handle, 1) - userBefore}.");
            if (GetGuiResources(process.Handle, 0) > gdiBefore + 2 || GetGuiResources(process.Handle, 1) > userBefore + 2)
                throw new Exception("Feedback handles grew during the second batch.");

            void Capture(string kind)
            {
                if (captureDirectory == null) return;
                Directory.CreateDirectory(captureDirectory);
                using var bitmap = new Bitmap(form.Width, form.Height);
                using var graphics = Graphics.FromImage(bitmap);
                graphics.CopyFromScreen(form.Location, Point.Empty, bitmap.Size);
                bitmap.Save(Path.Combine(captureDirectory, $"2026-11-12-ctrl-{kind}-feedback.png"));
            }
        }
        Application.DoEvents();
        var disposedGdi = GetGuiResources(process.Handle, 0);
        Console.WriteLine($"GDI handles before initialization={initialGdi}, warmed={warmedGdi}, after disposal={disposedGdi} (framework/font caches remain process-wide).");
        if (disposedGdi > warmedGdi) throw new Exception("Feedback drawing resources grew on disposal.");
    }

    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("user32.dll")] private static extern int GetGuiResources(IntPtr process, int flags);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromPoint(Point point, uint flags);
    [DllImport("shcore.dll")] private static extern int GetDpiForMonitor(IntPtr monitor, int kind, out uint x, out uint y);
}
