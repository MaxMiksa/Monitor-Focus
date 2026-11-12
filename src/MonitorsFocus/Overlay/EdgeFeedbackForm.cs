using System.Drawing.Drawing2D;
using Microsoft.Win32;

namespace MonitorsFocus.Overlay;

internal sealed record EdgeFeedback(string Name, string Value, float Progress, bool Temperature, bool Muted = false)
{
    public static EdgeFeedback Color(string name, int kelvin) =>
        new(name, $"{kelvin} K", (kelvin - 2700) / 3800f, true);

    public static EdgeFeedback Volume(string name, int level, bool muted, string mutedLabel) =>
        new(name, $"{level}%" + (muted ? $" · {mutedLabel}" : ""), level / 100f, false, muted);
}

// One lazily-created window in the core process. No image assets, web runtime,
// animation loop or hidden polling; the timer runs only while the pill is visible.
internal sealed class EdgeFeedbackForm : Form
{
    private readonly System.Windows.Forms.Timer _hide = new() { Interval = 1500 };
    private readonly Font _label = new("Segoe UI", 14, FontStyle.Regular, GraphicsUnit.Pixel);
    private readonly Font _number = new("Segoe UI", 14, FontStyle.Bold, GraphicsUnit.Pixel);
    private EdgeFeedback? _feedback;
    private bool _light;
    private bool _highContrast;
    private float _scale = 1;

    public EdgeFeedbackForm()
    {
        AutoScaleMode = AutoScaleMode.None;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        TopMost = true;
        DoubleBuffered = true;
        Opacity = 0.995;
        AccessibleRole = AccessibleRole.Indicator;
        _hide.Tick += (_, _) => Dismiss();
    }

    protected override bool ShowWithoutActivation => true;
    protected override CreateParams CreateParams
    {
        get
        {
            var parameters = base.CreateParams;
            parameters.ExStyle |= NativeMethods.WS_EX_NOACTIVATE | NativeMethods.WS_EX_TOOLWINDOW |
                NativeMethods.WS_EX_TRANSPARENT | NativeMethods.WS_EX_LAYERED;
            return parameters;
        }
    }

    public void Present(EdgeFeedback feedback, Rectangle workArea, int dpi, int hideAfterMilliseconds = 1500)
    {
        _feedback = feedback;
        _scale = dpi / 96f;
        if (!Visible) RefreshAppearance();
        var size = new Size((int)Math.Round(336 * _scale), (int)Math.Round(76 * _scale));
        var bounds = new Rectangle(workArea.Left + (workArea.Width - size.Width) / 2,
            workArea.Bottom - size.Height - (int)Math.Round(24 * _scale), size.Width, size.Height);
        if (Bounds != bounds)
        {
            Bounds = bounds;
            using var path = Rounded(new(0, 0, size.Width, size.Height), 12 * _scale);
            var old = Region;
            Region = new Region(path);
            old?.Dispose();
        }
        AccessibleName = $"{feedback.Name} {feedback.Value}";
        if (!Visible) Show();
        NativeMethods.SetWindowPos(Handle, NativeMethods.HWND_TOPMOST, 0, 0, 0, 0,
            NativeMethods.SWP_NOMOVE | NativeMethods.SWP_NOSIZE | NativeMethods.SWP_NOACTIVATE | NativeMethods.SWP_SHOWWINDOW);
        Invalidate();
        _hide.Stop();
        _hide.Interval = Math.Clamp(hideAfterMilliseconds, 1, 1500);
        _hide.Start();
    }

    public void Dismiss()
    {
        _hide.Stop();
        Hide();
        _feedback = null;
    }

    public void RefreshAppearance()
    {
        _light = (int?)Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1) != 0;
        _highContrast = SystemInformation.HighContrast;
        BackColor = _highContrast ? SystemColors.Window : _light ? Color.FromArgb(246, 246, 246) : Color.FromArgb(41, 41, 41);
        if (Visible) Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        if (_feedback is not { } feedback) return;
        var g = e.Graphics;
        var original = g.Save();
        g.ScaleTransform(_scale, _scale);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var text = _highContrast ? SystemColors.WindowText : _light ? Color.FromArgb(24, 24, 24) : Color.White;
        var accent = _highContrast ? SystemColors.Highlight : Color.FromArgb(70, 190, 240);
        using var foreground = new SolidBrush(text);
        using var outline = new Pen(_highContrast ? text : _light ? Color.FromArgb(215, 215, 215) : Color.FromArgb(24, 24, 24));
        using var body = Rounded(new(0.5f, 0.5f, 335, 75), 12);
        g.DrawPath(outline, body);
        using var left = new StringFormat { Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap };
        using var right = new StringFormat(left) { Alignment = StringAlignment.Far };
        g.DrawString(feedback.Name, _label, foreground, new RectangleF(44, 16, 142, 24), left);
        g.DrawString(feedback.Value, _number, foreground, new RectangleF(184, 16, 134, 24), right);
        using var icon = new Pen(text, 1.5f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
        if (feedback.Temperature)
        {
            g.DrawEllipse(icon, 20, 21, 8, 8);
            for (var i = 0; i < 8; i++)
            {
                var angle = i * Math.PI / 4;
                g.DrawLine(icon, 24 + (float)Math.Cos(angle) * 7, 25 + (float)Math.Sin(angle) * 7,
                    24 + (float)Math.Cos(angle) * 9, 25 + (float)Math.Sin(angle) * 9);
            }
        }
        else
        {
            g.DrawLines(icon, [new(17, 22), new(20, 22), new(25, 18), new(25, 32), new(20, 28), new(17, 28), new(17, 22)]);
            if (feedback.Muted) { g.DrawLine(icon, 29, 22, 34, 28); g.DrawLine(icon, 29, 28, 34, 22); }
            else g.DrawArc(icon, 24, 19, 9, 12, -65, 130);
        }
        var track = new RectangleF(44, 51, 274, 5);
        using var rail = Rounded(track, 2.5f);
        using var railBrush = new SolidBrush(_highContrast ? SystemColors.ControlDark : _light ? Color.FromArgb(180, 180, 180) : Color.FromArgb(145, 145, 145));
        g.FillPath(railBrush, rail);
        var state = g.Save();
        g.SetClip(rail);
        var progress = Math.Clamp(feedback.Progress, 0, 1);
        if (feedback.Temperature && !_highContrast)
        {
            using var gradient = new LinearGradientBrush(track, Color.FromArgb(245, 159, 83), accent, 0f);
            g.FillRectangle(gradient, track.X, track.Y, track.Width * progress, track.Height);
        }
        else
        {
            using var fill = new SolidBrush(accent);
            g.FillRectangle(fill, track.X, track.Y, track.Width * progress, track.Height);
        }
        g.Restore(state);
        g.Restore(original);
    }

    private static GraphicsPath Rounded(RectangleF bounds, float radius)
    {
        var path = new GraphicsPath();
        var d = radius * 2;
        path.AddArc(bounds.Left, bounds.Top, d, d, 180, 90);
        path.AddArc(bounds.Right - d, bounds.Top, d, d, 270, 90);
        path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _hide.Dispose();
            _label.Dispose();
            _number.Dispose();
            var region = Region;
            Region = null;
            region?.Dispose();
        }
        base.Dispose(disposing);
    }
}
