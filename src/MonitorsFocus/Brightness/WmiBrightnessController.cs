using System.Management;
using MonitorsFocus.Monitoring;

namespace MonitorsFocus.Brightness;

internal sealed class WmiBrightnessController : IBrightnessDevice
{
    private readonly string _instanceName;
    private readonly byte[] _levels;
    private readonly PhysicalDisplayScope _scope;

    private WmiBrightnessController(string instanceName, byte[] levels, PhysicalDisplayScope scope)
    {
        _instanceName = instanceName;
        _levels = levels;
        _scope = scope;
    }

    public static IBrightnessDevice? Open(string? deviceInstance, string displayName)
    {
        if (deviceInstance == null) return null;
        var scope = new PhysicalDisplayScope(displayName);
        using var searcher = new ManagementObjectSearcher("root\\wmi", "SELECT * FROM WmiMonitorBrightness");
        using var results = searcher.Get();
        WmiBrightnessController? match = null;
        foreach (ManagementObject item in results)
        {
            using (item)
            {
                var name = (string)item["InstanceName"];
                if (!(bool)item["Active"] || !DisplayIdentity.MatchesWmi(deviceInstance, name)) continue;
                if (match != null) return null;
                var levels = (byte[])item["Level"];
                if (levels.Length == 0) return null;
                match = new WmiBrightnessController(name, levels.Distinct().Order().ToArray(), scope);
            }
        }
        return match;
    }

    public int ReadBrightness()
    {
        using var searcher = new ManagementObjectSearcher("root\\wmi", "SELECT * FROM WmiMonitorBrightness");
        using var results = searcher.Get();
        foreach (ManagementObject item in results)
        {
            using (item)
            {
                if (string.Equals((string)item["InstanceName"], _instanceName, StringComparison.OrdinalIgnoreCase))
                    return (byte)item["CurrentBrightness"];
            }
        }
        throw new InvalidOperationException("The matched WMI display is no longer available.");
    }

    public void SetBrightness(int percent)
    {
        var target = _levels.MinBy(level => Math.Abs(level - Math.Clamp(percent, 0, 100)));
        using var searcher = new ManagementObjectSearcher("root\\wmi", "SELECT * FROM WmiMonitorBrightnessMethods");
        using var results = searcher.Get();
        foreach (ManagementObject item in results)
        {
            using (item)
            {
                if (!string.Equals((string)item["InstanceName"], _instanceName, StringComparison.OrdinalIgnoreCase)) continue;
                _scope.Ensure();
                var result = item.InvokeMethod("WmiSetBrightness", new object[] { 1u, target });
                if (result != null && Convert.ToUInt32(result) != 0)
                    throw new InvalidOperationException($"WMI brightness failed: {result}");
                return;
            }
        }
        throw new InvalidOperationException("No brightness method belongs to the requested display.");
    }

    public void Dispose() { }
}
