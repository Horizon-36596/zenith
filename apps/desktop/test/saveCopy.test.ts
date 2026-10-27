/**
 * Save a copy (sweep D4): the Save As dialog starts in Documents with the auto's own file name, a
 * cancel writes nothing and says so with null, and the close waits on the returned promise, so it
 * resolves only after the write.
 */
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeFailure } from "../src/main/project.js";
import { COPY_LIMIT_BYTES, saveCopy, saveFile, suggestedCopyName } from "../src/main/saveCopy.js";

const documents = join("C:", "Users", "member", "Documents");

describe("save a copy", () => {
  it("suggests the auto's own name, with any folder part dropped", () => {
    expect(suggestedCopyName("collect-and-score.auto.json")).toBe("collect-and-score.auto.json");
    expect(suggestedCopyName("..\\..\\Windows\\win.ini")).toBe("win.ini.auto.json");
    expect(suggestedCopyName("../../etc/passwd.json")).toBe("passwd.json");
    expect(suggestedCopyName("first-auto")).toBe("first-auto.auto.json");
    expect(suggestedCopyName("")).toBe("untitled.auto.json");
    expect(suggestedCopyName(42)).toBe("untitled.auto.json");
    expect(suggestedCopyName("a<b>:c.auto.json")).toBe("abc.auto.json");
  });

  it("writes the text where the person chose, then resolves with the file's name", async () => {
    const order: string[] = [];
    const ask = vi.fn(async (defaultPath: string) => {
      order.push("ask");
      expect(defaultPath).toBe(join(documents, "first-auto.auto.json"));
      return join(documents, "copies", "mine.auto.json");
    });
    const write = vi.fn((path: string, text: string) => {
      order.push("write");
      expect(path).toBe(join(documents, "copies", "mine.auto.json"));
      expect(text).toBe('{"name":"first-auto"}\n');
    });
    const saved = await saveCopy({ ask, write, folder: documents }, "first-auto.auto.json", '{"name":"first-auto"}\n');
    order.push("resolved");
    expect(saved).toBe("mine.auto.json");
    expect(order).toEqual(["ask", "write", "resolved"]);
  });

  it("writes nothing and resolves null when the dialog is cancelled", async () => {
    const write = vi.fn();
    expect(await saveCopy({ ask: async () => null, write, folder: documents }, "a.auto.json", "{}")).toBeNull();
    expect(await saveCopy({ ask: async () => "", write, folder: documents }, "a.auto.json", "{}")).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses what is not an auto's text, before any dialog", async () => {
    const ask = vi.fn(async () => "x.auto.json");
    const write = vi.fn();
    await expect(saveCopy({ ask, write, folder: documents }, "a.auto.json", 7)).rejects.toThrow(/nothing to save/);
    await expect(saveCopy({ ask, write, folder: documents }, "a.auto.json", "x".repeat(COPY_LIMIT_BYTES + 1))).rejects.toThrow(/too large/);
    expect(ask).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("says which file could not be written", async () => {
    const write = () => {
      throw new Error("EACCES: permission denied");
    };
    await expect(
      saveCopy({ ask: async () => join(documents, "locked.auto.json"), write, folder: documents }, "a.auto.json", "{}"),
    ).rejects.toThrow(/could not be written to locked.auto.json\. EACCES: permission denied/);
  });
});

describe("save a file the page made", () => {
  it("asks with the file's own kind, writes bytes or text, and resolves with the name", async () => {
    const ask = vi.fn(async (defaultPath: string) => defaultPath);
    const write = vi.fn();
    const bytes = new Uint8Array([137, 80, 78, 71]);
    expect(await saveFile({ ask, write, folder: documents }, "first-auto.red.png", bytes)).toBe("first-auto.red.png");
    expect(ask).toHaveBeenCalledWith(join(documents, "first-auto.red.png"), { name: "PNG picture", extensions: ["png"] });
    expect(write).toHaveBeenCalledWith(join(documents, "first-auto.red.png"), bytes);
    expect(await saveFile({ ask, write, folder: documents }, "first-auto.red.svg", "<svg/>")).toBe("first-auto.red.svg");
  });

  it("resolves null and writes nothing when the dialog is cancelled", async () => {
    const write = vi.fn();
    expect(await saveFile({ ask: async () => null, write, folder: documents }, "first-auto.auto.json", "{}")).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it("saves only autos and pictures, under a bare name", async () => {
    const ask = vi.fn(async (defaultPath: string) => defaultPath);
    const deps = { ask, write: vi.fn(), folder: documents };
    await expect(saveFile(deps, "evil.exe", "x")).rejects.toThrow("Zenith saves only autos and pictures of them here.");
    await expect(saveFile(deps, "x.constructor", "x")).rejects.toThrow("Zenith saves only autos and pictures of them here.");
    await expect(saveFile(deps, "x.png", 42)).rejects.toThrow("There was nothing to save.");
    await saveFile(deps, "..\\..\\Windows\\a.svg", "<svg/>");
    expect(ask).toHaveBeenLastCalledWith(join(documents, "a.svg"), expect.anything());
  });
});

describe("a save that fails", () => {
  it("says what went wrong and what to do, not the raw Node error", () => {
    const error = (code: string) => Object.assign(new Error(`${code}: operation not permitted, open 'C:\\robot\\autos\\first-auto.auto.json'`), { code });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const full = join("C:", "robot", "autos", "first-auto.auto.json");
    expect(String(writeFailure(full, error("EPERM")))).toContain(
      "first-auto.auto.json could not be saved: it is read only, or another program has it open. Close it there or make it writable, then save again.",
    );
    expect(String(writeFailure(full, error("ENOSPC")))).toContain("the disk is full. Free some space, then save again.");
    // The raw error still goes to stderr, where a bug report starts.
    expect(quiet).toHaveBeenCalled();
    // An error it does not know is passed on as it was.
    const other = error("EOTHER");
    expect(writeFailure(full, other)).toBe(other);
    quiet.mockRestore();
  });
});
