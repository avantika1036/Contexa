param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 2147483647)]
  [int]$TargetPid
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

# Always return one compact JSON object and exit successfully for expected probe
# failures. A missing process/UIA tree is not evidence that the meeting ended.
$probeClock = [System.Diagnostics.Stopwatch]::StartNew()

$result = [ordered]@{
  pid = $TargetPid
  hostedInstance = $false
  executablePathVerified = $false
  accessoriesHelper = $false
  inspected = $false
  meetingControlsPresent = $false
  error = $null
  elapsedMs = 0
}

try {
  # Get-CimInstance is present on supported Windows 10/11 systems. Keep a WMI
  # fallback for older PowerShell/CIM provider installations.
  $processInfo = $null
  try {
    $processInfo = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$TargetPid" -ErrorAction Stop
  } catch {
    $processInfo = Get-WmiObject -Class Win32_Process -Filter "ProcessId=$TargetPid" -ErrorAction Stop
  }

  if (-not $processInfo -or $processInfo.Name -ine 'CiscoCollabHost.exe') {
    throw 'WebexHostProcessUnavailable'
  }

  $commandLine = [string]$processInfo.CommandLine
  $expectedHost = Join-Path $env:LOCALAPPDATA 'CiscoSparkLauncher\CiscoCollabHost.exe'
  $result.hostedInstance = [bool]($commandLine -match '(?i)(?:^|\s)/Hosted=true(?:\s|$)')
  $result.accessoriesHelper = [bool]($commandLine -match '(?i)"accessories"')
  $result.executablePathVerified = [bool]([String]::Equals(
    [string]$processInfo.ExecutablePath,
    $expectedHost,
    [StringComparison]::OrdinalIgnoreCase
  ))

  if (-not $result.hostedInstance -or -not $result.executablePathVerified -or $result.accessoriesHelper) {
    throw 'WebexHostEvidenceNotVerified'
  }

  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
  Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop

  # Use New-Object rather than the static ::new() constructor. This matches the
  # Windows PowerShell 5.1 UIA diagnostic that was verified against this Webex
  # client and avoids constructor-binding differences in older PowerShell hosts.
  $pidCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
    [int]$TargetPid
  )

  # First enumerate only direct desktop children (top-level windows). The previous
  # RootElement.FindAll(Descendants, PID) traversed every UIA node on the desktop and
  # returned ~1,900 nodes for this Webex process, occasionally exceeding Electron's
  # child-process timeout. Resolve the exact Webex top-level window first.
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $hostWindows = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    $pidCondition
  )

  if ($null -eq $hostWindows -or $hostWindows.Count -lt 1) {
    throw 'WebexTopLevelWindowUnavailable'
  }

  # The Webex window was successfully inspected. No matching meeting controls now
  # represents an idle/left window and is debounced by WebexMeetingControlTracker.
  # Search all known control names in a single UIA traversal. The previous version
  # performed up to four independent Descendants scans, which made probes take
  # ~9-10 seconds and occasionally hit Electron's child-process timeout.
  $result.inspected = $true
  $controlNames = @('End meeting', 'Leave meeting', 'End call', 'Leave call')
  $nameConditions = @(
    foreach ($controlName in $controlNames) {
      New-Object -TypeName System.Windows.Automation.PropertyCondition -ArgumentList @(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        [string]$controlName
      )
    }
  )
  $combinedNameCondition = New-Object -TypeName System.Windows.Automation.OrCondition -ArgumentList (,$nameConditions)
  foreach ($hostWindow in $hostWindows) {
    try {
      $control = $hostWindow.FindFirst(
        [System.Windows.Automation.TreeScope]::Descendants,
        $combinedNameCondition
      )
      if ($null -ne $control) {
        $result.meetingControlsPresent = $true
        break
      }
    } catch {
      # Treat a failed accessibility tree query as unknown, not as an absence scan.
      $result.inspected = $false
      $result.error = $_.Exception.GetType().Name
    }
  }
} catch {
  $result.inspected = $false
  $result.meetingControlsPresent = $false
  $result.error = $_.Exception.GetType().Name
}

# Emit JSON explicitly; no process metadata, raw command line, protocol URI,
# executable path, or UI Automation tree is included in the output.
$probeClock.Stop()
$result.elapsedMs = [int]$probeClock.ElapsedMilliseconds
[Console]::Out.WriteLine((ConvertTo-Json -InputObject ([PSCustomObject]$result) -Compress -Depth 3))
exit 0
