namespace MonitorsFocus.Brightness;

internal interface ITemperatureDevice : IDisposable
{
    void Apply(int? kelvin);
}
