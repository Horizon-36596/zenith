/**
 * Opting the sim server's JVM out of Windows power throttling (powerThrottling.ts): only on Windows,
 * only for a real pid, and with the pid as the only thing put into the script.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFile = vi.fn();
vi.mock("node:child_process", () => ({ execFile }));

const { unthrottleProcess } = await import("../src/main/powerThrottling.js");

const host = (platform: NodeJS.Platform) => ({ platform, env: {}, exists: () => false });

describe("unthrottleProcess", () => {
  beforeEach(() => {
    execFile.mockReset();
  });

  it("runs PowerShell once, hidden, for a positive integer pid on Windows", () => {
    unthrottleProcess(4321, host("win32"));
    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFile.mock.calls[0] as [string, string[], { windowsHide: boolean }];
    expect(file).toBe("powershell.exe");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(args[3]).toContain("OpenProcess(0x0200, $false, 4321)");
    expect(options.windowsHide).toBe(true);
  });

  it("does nothing on other platforms", () => {
    unthrottleProcess(4321, host("linux"));
    unthrottleProcess(4321, host("darwin"));
    expect(execFile).not.toHaveBeenCalled();
  });

  it("does nothing for a pid that is not a positive integer", () => {
    for (const pid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) unthrottleProcess(pid, host("win32"));
    expect(execFile).not.toHaveBeenCalled();
  });
});
