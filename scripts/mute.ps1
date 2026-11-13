param([string]$Action = "status")  # on | off | status

$code = @'
using System;
using System.Runtime.InteropServices;
public class AudioMute {
    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioEndpointVolume {
        int RegisterControlChangeNotify(IntPtr n); int UnregisterControlChangeNotify(IntPtr n);
        int GetChannelCount(out int c);
        int SetMasterVolumeLevel(float l, Guid g); int SetMasterVolumeLevelScalar(float l, Guid g);
        int GetMasterVolumeLevel(out float l); int GetMasterVolumeLevelScalar(out float l);
        int SetChannelVolumeLevel(int c, float l, Guid g); int SetChannelVolumeLevelScalar(int c, float l, Guid g);
        int GetChannelVolumeLevel(int c, out float l); int GetChannelVolumeLevelScalar(int c, out float l);
        int SetMute(bool m, Guid g); int GetMute(out bool m);
    }
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator {
        int EnumAudioEndpoints(int flow, int mask, IntPtr outColl);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        int GetDefaultAudioEndpointCom(int flow, int role, IntPtr dev);
    }
    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }
    public static object GetEndpoint() {
        var en = (IMMDeviceEnumerator)(object)new MMDeviceEnumeratorCom();
        IMMDevice dev;
        int hr = en.GetDefaultAudioEndpoint(0 /*eRender*/, 1 /*eMultimedia*/, out dev);
        if (hr != 0) throw new Exception("GetDefaultAudioEndpoint hr=0x" + hr.ToString("X"));
        Guid iid = typeof(IAudioEndpointVolume).GUID;
        object o;
        hr = dev.Activate(ref iid, 23 /*CLSCTX_ALL*/, IntPtr.Zero, out o);
        if (hr != 0) throw new Exception("Activate hr=0x" + hr.ToString("X"));
        return o;
    }
    public static bool Mute(bool m) { ((IAudioEndpointVolume)GetEndpoint()).SetMute(m, Guid.Empty); return Get(); }
    public static bool Get() { bool v; ((IAudioEndpointVolume)GetEndpoint()).GetMute(out v); return v; }
}
'@
Add-Type -TypeDefinition $code

switch ($Action) {
  "on"     { Write-Output ("muted=" + [AudioMute]::Mute($true)) }
  "off"    { Write-Output ("muted=" + [AudioMute]::Mute($false)) }
  default  { Write-Output ("muted=" + [AudioMute]::Get()) }
}
