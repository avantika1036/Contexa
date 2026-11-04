$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class ContexaBasicWindowEnumerator {
  public sealed class WindowInfo {
    public int pid { get; set; }
    public string processName { get; set; }
    public string title { get; set; }
    public string windowId { get; set; }
    public bool foreground { get; set; }
    public int foregroundProcessId { get; set; }
    public string foregroundWindowId { get; set; }
  }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  public static List<WindowInfo> GetWindows() {
    var rows = new List<WindowInfo>();
    IntPtr foregroundHandle = GetForegroundWindow();
    IntPtr foregroundRoot = GetAncestor(foregroundHandle, 2); // GA_ROOT
    uint foregroundPid;
    GetWindowThreadProcessId(foregroundHandle, out foregroundPid);
    string foregroundRootId = foregroundRoot == IntPtr.Zero ? "" : foregroundRoot.ToInt64().ToString();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      if (!IsWindowVisible(hWnd)) return true;
      int length = GetWindowTextLength(hWnd);
      if (length <= 0) return true;
      var title = new StringBuilder(length + 1);
      GetWindowText(hWnd, title, title.Capacity);
      if (title.Length == 0) return true;
      uint processId;
      GetWindowThreadProcessId(hWnd, out processId);
      try {
        using (var process = Process.GetProcessById((int)processId)) {
          rows.Add(new WindowInfo {
            pid = (int)processId,
            processName = process.ProcessName,
            title = title.ToString(),
            windowId = hWnd.ToInt64().ToString(),
            // The exact foreground HWND and its GA_ROOT are authoritative. Do not
            // mark the owner window as foreground too; popups can have a different owner.
            foreground = hWnd == foregroundHandle
              || (foregroundRoot != IntPtr.Zero && hWnd == foregroundRoot),
            foregroundProcessId = (int)foregroundPid,
            foregroundWindowId = foregroundRootId
          });
        }
      } catch { }
      return true;
    }, IntPtr.Zero);
    return rows;
  }
}
'@

$rows = [ContexaBasicWindowEnumerator]::GetWindows()
ConvertTo-Json -InputObject @($rows) -Compress -Depth 3
