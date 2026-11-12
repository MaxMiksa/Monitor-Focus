using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;
using MonitorsFocus.Brightness;
using MonitorsFocus.Monitoring;

internal static class GammaProbe
{
    public static void Run(string[] args)
    {
        string? Option(string name) => Array.IndexOf(args, name) is var index && index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
        var apply = args.Contains("--apply");
        var interactive = args.Contains("--interactive");
        var hold = Math.Clamp(int.Parse(Option("--hold") ?? "6"), 1, 15);
        var kelvin = Math.Clamp(int.Parse(Option("--kelvin") ?? "3500"), 2700, 6500);
        var selected = Option("--display");
        using var manager = new MonitorManager();
        var outputs = new List<(MonitorInfo Monitor, NativeGammaRamp Ramp, ushort[] Baseline)>();
        var colors = new List<GammaColorDevice>();
        try
        {
            foreach (var monitor in manager.Monitors)
            {
                var ramp = new NativeGammaRamp(monitor.Id);
                try
                {
                    if (!ramp.IsSdr) throw new InvalidOperationException($"{monitor.Id}: HDR/Advanced Color/unknown topology; probe skipped.");
                    outputs.Add((monitor, ramp, ramp.Read()));
                }
                catch { ramp.Dispose(); throw; }
                Console.WriteLine($"{monitor.Id} | Primary={monitor.IsPrimary} | Internal={DisplayColorMode.IsInternal(monitor.Id)} | {DisplayIdentity.FindInstance(monitor.Id)} | SDR | gamma readable");
            }
            if (!apply) return;
            var targets = outputs.Where(o => selected == null || o.Monitor.Id == selected).ToArray();
            if (targets.Length == 0) throw new ArgumentException("Requested output is not connected.");
            foreach (var target in targets)
            {
                var color = new GammaColorDevice(target.Ramp);
                colors.Add(color);
                using var reference = new Form
                {
                    Text = "屏幕冷暖测试 · 自动恢复", BackColor = Color.White, ForeColor = Color.Black,
                    StartPosition = FormStartPosition.Manual, Size = new Size(560, 340), TopMost = true,
                    FormBorderStyle = FormBorderStyle.FixedToolWindow
                };
                reference.Location = new Point(target.Monitor.Bounds.Left + (target.Monitor.Bounds.Width - reference.Width) / 2,
                    target.Monitor.Bounds.Top + (target.Monitor.Bounds.Height - reference.Height) / 2);
                var label = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter,
                    Font = new Font("Microsoft YaHei UI", 16), BackColor = Color.White };
                reference.Controls.Add(label);
                if (interactive)
                {
                    var buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 52, BackColor = Color.White };
                    var warmButton = new Button { Text = "变暖", AutoSize = true, Height = 36 };
                    var restoreButton = new Button { Text = "恢复原色", AutoSize = true, Height = 36 };
                    var doneButton = new Button { Text = "完成测试", AutoSize = true, Height = 36 };
                    warmButton.Click += (_, _) =>
                    {
                        try
                        {
                            color.Apply(kelvin);
                            var isolated = outputs.Where(o => o.Monitor.Id != target.Monitor.Id).All(o => o.Ramp.Read().SequenceEqual(o.Baseline));
                            label.Text = "当前：暖色\n请观察白色区域是否变黄\n点击恢复原色可反复比较";
                            Console.WriteLine($"{target.Monitor.Id} | interactive warm accepted | other outputs unchanged={isolated}");
                            if (!isolated) throw new InvalidOperationException("The other output changed.");
                        }
                        catch (Exception ex) { label.Text = ex.Message; }
                    };
                    restoreButton.Click += (_, _) =>
                    {
                        try { color.Apply(null); label.Text = "当前：原色\n点击变暖可反复比较"; }
                        catch (Exception ex) { label.Text = ex.Message; }
                    };
                    doneButton.Click += (_, _) => reference.Close();
                    buttons.Controls.AddRange([warmButton, restoreButton, doneButton]);
                    reference.Controls.Add(buttons);
                    label.Text = "当前：原色\n准备好后点击下方「变暖」\n测试窗会保留，直到你关闭";
                    Application.Run(reference);
                    color.Apply(null);
                    continue;
                }
                reference.Show();
                for (var round = 0; round < 2; round++)
                {
                    label.Text = "原色参照\n请观察这块白色区域\n4 秒后变暖";
                    Wait(4);
                    label.Text = $"暖色测试 · 约 {kelvin} K\n{hold} 秒后恢复原色";
                    color.Apply(kelvin);
                    var expected = GammaColorDevice.WarmRamp(target.Baseline, kelvin);
                    var matches = target.Ramp.Read().SequenceEqual(expected);
                    var isolated = outputs.Where(o => o.Monitor.Id != target.Monitor.Id).All(o => o.Ramp.Read().SequenceEqual(o.Baseline));
                    Console.WriteLine($"{target.Monitor.Id} | round={round + 1} | readback={matches} | other outputs unchanged={isolated}");
                    if (!matches || !isolated) throw new InvalidOperationException("Gamma readback or output isolation failed.");
                    Wait(hold);
                    color.Apply(null);
                    if (!target.Ramp.Read().SequenceEqual(target.Baseline)) throw new InvalidOperationException("Restore readback failed.");
                }
                label.Text = "已恢复原色";
                Wait(2);
            }
        }
        finally
        {
            var failures = new List<Exception>();
            foreach (var color in colors)
                try { color.Apply(null); } catch (Exception ex) { failures.Add(ex); }
            foreach (var output in outputs)
            {
                try
                {
                    var restored = output.Ramp.Read().SequenceEqual(output.Baseline);
                    Console.WriteLine($"{output.Monitor.Id} | final baseline restored={restored}");
                    if (apply && !restored) failures.Add(new InvalidOperationException($"{output.Monitor.Id}: baseline differs; another color tool may have changed it."));
                }
                catch (Exception ex) { failures.Add(ex); }
                finally { output.Ramp.Dispose(); }
            }
            if (failures.Count > 0) throw new AggregateException(failures);
        }
    }

    private static void Wait(int seconds)
    {
        var until = Stopwatch.StartNew();
        while (until.Elapsed < TimeSpan.FromSeconds(seconds))
        {
            Application.DoEvents();
            Thread.Sleep(30);
        }
    }
}
