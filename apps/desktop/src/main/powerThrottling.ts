/**
 * Asks Windows not to slow a sim server down.
 *
 * Windows 11 throttles processes it takes for background work ("power throttling", EcoQoS), and a JVM
 * with no window of its own counts. Measured on one team's robot code on a team laptop on mains power,
 * 2026-10-15: a throttled sim server took 3.2 to 8.5 s to finish a 30 s auto on about half a core; the
 * same server unthrottled took 0.8 to 2.1 s. The person chose Fast or Ultrafast to get
 * that speed, so the desktop app opts the server's JVM out, with the documented Win32 call
 * `SetProcessInformation(ProcessPowerThrottling)` and the execution-speed bit cleared.
 *
 * Node has no binding for that call, so a short PowerShell compiles one and makes it. It runs once per
 * server start, in the background, and a failure only leaves the server as Windows had it. Other
 * platforms do nothing.
 */
import { execFile } from "node:child_process";
import { hostPlatform, type Platform } from "./cli.js";

/** `PROCESS_SET_INFORMATION`, `ProcessPowerThrottling` and `PROCESS_POWER_THROTTLING_EXECUTION_SPEED`, from the Windows SDK. */
const SCRIPT = (pid: number): string => `Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class ZenithPowerThrottling {
  [StructLayout(LayoutKind.Sequential)] public struct State { public uint Version; public uint ControlMask; public uint StateMask; }
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetProcessInformation(IntPtr process, int infoClass, ref State info, int size);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
"@
$h = [ZenithPowerThrottling]::OpenProcess(0x0200, $false, ${String(pid)})
if ($h -eq [IntPtr]::Zero) { exit 1 }
$s = New-Object ZenithPowerThrottling+State
$s.Version = 1; $s.ControlMask = 1; $s.StateMask = 0
$ok = [ZenithPowerThrottling]::SetProcessInformation($h, 4, [ref]$s, 12)
[void][ZenithPowerThrottling]::CloseHandle($h)
if (-not $ok) { exit 1 }`;

/** Opts process `pid` out of power throttling on Windows; does nothing elsewhere or for a pid that is not a positive integer. */
export function unthrottleProcess(pid: number, host: Platform = hostPlatform()): void {
  if (host.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) return;
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT(pid)], { windowsHide: true }, () => undefined);
}
