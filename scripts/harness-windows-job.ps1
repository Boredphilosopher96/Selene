$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class HarnessJobSupervisor {
  private const uint JobObjectExtendedLimitInformation = 9;
  private const uint JobObjectLimitKillOnJobClose = 0x00002000;
  private const uint CreateSuspended = 0x00000004;
  private const uint Synchronize = 0x00100000;
  private const uint WaitObject0 = 0;
  private const uint WaitTimeout = 0x00000102;
  private const uint WaitFailed = 0xFFFFFFFF;

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
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo {
    public int cb;
    public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] private struct ProcessInformation {
    public IntPtr hProcess, hThread;
    public int dwProcessId, dwThreadId;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(IntPtr job, uint infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CreateProcess(
    string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
    bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory,
    ref StartupInfo startupInfo, out ProcessInformation processInformation);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetExitCodeProcess(IntPtr process, out int exitCode);

  private static void Require(bool succeeded) {
    if (!succeeded) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  private static string Quote(string value) {
    if (value.Length == 0) return "\"\"";
    if (value.IndexOfAny(new[] { ' ', '\t', '\"' }) < 0) return value;
    var result = new StringBuilder("\"");
    var slashes = 0;
    foreach (var character in value) {
      if (character == '\\') { slashes++; continue; }
      if (character == '\"') result.Append('\\', slashes * 2 + 1);
      else result.Append('\\', slashes);
      result.Append(character);
      slashes = 0;
    }
    result.Append('\\', slashes * 2);
    return result.Append('\"').ToString();
  }
  private static StringBuilder CommandLine(string applicationName, string[] arguments) {
    var line = new StringBuilder(Quote(applicationName));
    foreach (var argument in arguments) line.Append(' ').Append(Quote(argument));
    return line;
  }
  public static int Run(string applicationName, string[] arguments, int parentPid) {
    IntPtr job = IntPtr.Zero, parent = IntPtr.Zero, process = IntPtr.Zero, thread = IntPtr.Zero;
    try {
      parent = OpenProcess(Synchronize, false, parentPid);
      if (parent == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    var limits = new ExtendedLimitInformation();
    limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
    int size = Marshal.SizeOf(limits);
    IntPtr memory = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(limits, memory, false);
      Require(SetInformationJobObject(job, JobObjectExtendedLimitInformation, memory, (uint)size));
    } finally { Marshal.FreeHGlobal(memory); }
      var startupInfo = new StartupInfo();
      startupInfo.cb = Marshal.SizeOf(startupInfo);
      ProcessInformation processInfo;
      Require(CreateProcess(applicationName, CommandLine(applicationName, arguments), IntPtr.Zero, IntPtr.Zero,
        true, CreateSuspended, IntPtr.Zero, null, ref startupInfo, out processInfo));
      process = processInfo.hProcess;
      thread = processInfo.hThread;
      Require(AssignProcessToJobObject(job, process));
      if (ResumeThread(thread) == 0xFFFFFFFF) throw new Win32Exception(Marshal.GetLastWin32Error());
      CloseHandle(thread);
      thread = IntPtr.Zero;
      while (true) {
        uint childState = WaitForSingleObject(process, 100);
        if (childState == WaitObject0) {
          int exitCode;
          Require(GetExitCodeProcess(process, out exitCode));
          return exitCode;
        }
        if (childState == WaitFailed) throw new Win32Exception(Marshal.GetLastWin32Error());
        uint parentState = WaitForSingleObject(parent, 0);
        if (parentState == WaitObject0) return 1;
        if (parentState != WaitTimeout) throw new Win32Exception(Marshal.GetLastWin32Error());
      }
    } finally {
      if (thread != IntPtr.Zero) CloseHandle(thread);
      if (process != IntPtr.Zero) CloseHandle(process);
      if (job != IntPtr.Zero) CloseHandle(job);
      if (parent != IntPtr.Zero) CloseHandle(parent);
    }
  }
}
'@

$spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SELENE_HARNESS_WINDOWS_SPEC)) |
  ConvertFrom-Json
exit [HarnessJobSupervisor]::Run([string]$spec.command, [string[]]$spec.arguments, [int]$spec.parentPid)
