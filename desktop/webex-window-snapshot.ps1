$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

# This script is launched with powershell.exe -STA -File. Keep stdout JSON-only;
# diagnostics are returned as compact, sanitized fields on the matching Webex row.

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class ContexaWindowEnumerator {
  public sealed class WindowInfo {
    public int pid { get; set; }
    public string processName { get; set; }
    public string title { get; set; }
    public string windowId { get; set; }
    public bool foreground { get; set; }
  }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public static List<WindowInfo> GetWindows() {
    var rows = new List<WindowInfo>();
    IntPtr foregroundHandle = GetForegroundWindow();
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
            foreground = hWnd == foregroundHandle
          });
        }
      } catch { }
      return true;
    }, IntPtr.Zero);
    return rows;
  }
}
'@

$rows = [ContexaWindowEnumerator]::GetWindows()

# Read only compact process flags. Never emit command lines, protocol URIs, meeting
# tokens, or executable paths in the returned snapshot.
$webexMetadata = @{}
$expectedWebexHost = Join-Path $env:LOCALAPPDATA 'CiscoSparkLauncher\CiscoCollabHost.exe'
try {
  Get-CimInstance -ClassName Win32_Process -Filter "Name='CiscoCollabHost.exe'" -ErrorAction Stop | ForEach-Object {
    $commandLine = [string]$_.CommandLine
    $webexMetadata[[int]$_.ProcessId] = @{
      hostedInstance = [bool]($commandLine -match '(?i)(?:^|\s)/Hosted=true(?:\s|$)')
      accessoriesHelper = [bool]($commandLine -match '(?i)"accessories"')
      executablePathVerified = [bool]([String]::Equals([string]$_.ExecutablePath, $expectedWebexHost, [StringComparison]::OrdinalIgnoreCase))
    }
  }
} catch {
  # A CIM permission/provider issue must not crash ordinary window detection.
  $webexMetadataError = $_.Exception.GetType().Name
}

$uiAutomationReady = $false
$uiAutomationAssemblyError = $null
try {
  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
  Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
  $uiAutomationReady = $true
} catch {
  $uiAutomationAssemblyError = $_.Exception.GetType().Name
}

foreach ($row in $rows) {
  if ($row.processName -ine 'CiscoCollabHost' -or $row.title -ine 'Webex') { continue }
  $metadata = $webexMetadata[[int]$row.pid]
  if (-not $metadata) {
    $row | Add-Member -NotePropertyName webexUiAutomationInspected -NotePropertyValue $false -Force
    $row | Add-Member -NotePropertyName webexUiAutomationError -NotePropertyValue ($(if ($webexMetadataError) { "process-metadata-$webexMetadataError" } else { 'process-metadata-unavailable' })) -Force
    continue
  }

  $row | Add-Member -NotePropertyName webexHostedInstance -NotePropertyValue ([bool]$metadata.hostedInstance) -Force
  $row | Add-Member -NotePropertyName webexAccessoriesHelper -NotePropertyValue ([bool]$metadata.accessoriesHelper) -Force
  $row | Add-Member -NotePropertyName webexExecutablePathVerified -NotePropertyValue ([bool]$metadata.executablePathVerified) -Force

  $inspected = $false
  $meetingControlsPresent = $false
  $uiaError = $null
  if ($uiAutomationReady -and $metadata.hostedInstance -and $metadata.executablePathVerified -and -not $metadata.accessoriesHelper) {
    try {
      # Match the successful interactive diagnostic: query all UIA descendants
      # owned by the visible HWND's process and inspect only control names.
      $pidCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
        [int]$row.pid
      )
      $elements = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $pidCondition
      )
      $inspected = $true
      foreach ($element in $elements) {
        try {
          $controlName = [string]$element.Current.Name
          if ($controlName -match '^(?i:end meeting|leave meeting|end call|leave call)$') {
            $meetingControlsPresent = $true
            break
          }
        } catch {
          # Individual stale UIA nodes are expected while the tree changes.
        }
      }
    } catch {
      $uiaError = $_.Exception.GetType().Name
    }
  } elseif (-not $uiAutomationReady) {
    $uiaError = "assembly-$uiAutomationAssemblyError"
  } elseif (-not $metadata.hostedInstance) {
    $uiaError = 'not-hosted-instance'
  } elseif (-not $metadata.executablePathVerified) {
    $uiaError = 'unverified-executable'
  }

  $row | Add-Member -NotePropertyName webexUiAutomationInspected -NotePropertyValue ([bool]$inspected) -Force
  $row | Add-Member -NotePropertyName webexMeetingControlsPresent -NotePropertyValue ([bool]$meetingControlsPresent) -Force
  if ($uiaError) {
    $row | Add-Member -NotePropertyName webexUiAutomationError -NotePropertyValue ([string]$uiaError) -Force
  }
}

# ConvertTo-Json must be the only success-path stdout output.
ConvertTo-Json -InputObject @($rows) -Compress -Depth 4
