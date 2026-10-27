/**
 * Every Copy answers one way and fails one way (app/copyText.ts): "Copied the link." on the status
 * line, and when the browser refuses, the text selected and "press Ctrl C".
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const said: Array<{ kind: string; message: string }> = [];
vi.mock("../state/store", () => ({
  setStatus: (kind: string, message: string) => {
    said.push({ kind, message });
  },
}));

const { copyFailedWords, copyText, copiedWords } = await import("./copyText");

const withClipboard = (writeText: ((text: string) => Promise<void>) | undefined): void => {
  vi.stubGlobal("navigator", writeText === undefined ? {} : { clipboard: { writeText } });
};

afterEach(() => {
  said.length = 0;
  vi.unstubAllGlobals();
});

describe("copyText", () => {
  it("copies and says what it copied", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    withClipboard(writeText);
    expect(await copyText("the link", "https://example.test/s/abc")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://example.test/s/abc");
    expect(said).toEqual([{ kind: "ok", message: "Copied the link." }]);
  });

  it("says the one failure line when the browser refuses", async () => {
    withClipboard(() => Promise.reject(new Error("denied")));
    expect(await copyText("the sim command", "pnpm sim")).toBe(false);
    expect(said).toEqual([{ kind: "error", message: "This browser did not let Zenith copy the sim command. Select it and press Ctrl C." }]);
  });

  it("fails the same way without a clipboard at all, and gives the text when nothing shows it", async () => {
    withClipboard(undefined);
    expect(await copyText("the position of park", '{"xIn":1}', { shown: '{"xIn":1}' })).toBe(false);
    expect(said[0]?.message).toBe('This browser did not let Zenith copy the position of park. It is {"xIn":1}');
  });
});

describe("the copy words", () => {
  it("name the thing, and say Ctrl C when the text is selected", () => {
    expect(copiedWords("your user code")).toBe("Copied your user code.");
    expect(copyFailedWords("the report", true)).toBe("This browser did not let Zenith copy the report. It is selected: press Ctrl C to copy it.");
  });
});
