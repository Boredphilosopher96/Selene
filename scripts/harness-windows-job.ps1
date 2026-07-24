param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$FileName,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CommandArguments
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

public sealed class HarnessJob : IDisposable {
  private const uint JobObjectExtendedLimitInformation = 9;
  private const uint JobObjectLimitKillOnJobClose = 0x00002000;

  [StructLayout(LayoutKind.Sequential)] private struct IoCounters {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] private struct BasicLimitInformation {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimitInformation {
    public BasicLimitInformation BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(IntPtr job, uint infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  private IntPtr handle;
  public HarnessJob() {
    handle = CreateJobObject(IntPtr.Zero, null);
    if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    var limits = new ExtendedLimitInformation();
    limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
    int size = Marshal.SizeOf(limits);
    IntPtr memory = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(limits, memory, false);
      if (!SetInformationJobObject(handle, JobObjectExtendedLimitInformation, memory, (uint)size))
        throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(memory); }
  }
  public void Assign(Process process) {
    if (!AssignProcessToJobObject(handle, process.Handle))
      throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  public void Dispose() {
    if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
  }
}
'@

function ConvertTo-CommandLineArgument([string]$Value) {
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"' + (($Value -replace '(\\*)"', '$1$1\\"') -replace '(\\*)$', '$1$1') + '"'
}

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $FileName
$startInfo.Arguments = ($CommandArguments | ForEach-Object { ConvertTo-CommandLineArgument $_ }) -join ' '
$startInfo.UseShellExecute = $false

$job = [HarnessJob]::new()
$exitCode = 1
try {
  $child = [System.Diagnostics.Process]::Start($startInfo)
  $job.Assign($child)
  $child.WaitForExit()
  $exitCode = $child.ExitCode
} finally {
  # Closing this handle kills the complete assigned process tree before the
  # supervisor reports its own exit to Node.
  $job.Dispose()
}
exit $exitCode
