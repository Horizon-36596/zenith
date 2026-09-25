import { afterEach, describe, expect, it, vi } from "vitest";
import { fallbackTheme, LIGHT_FIELD_INK, liveInk, readTheme } from "./theme.js";

describe("the light-field ink", () => {
  const theme = fallbackTheme();

  it("is the resolved theme itself when the light picture is not showing", () => {
    expect(liveInk(theme, false)).toBe(theme);
  });

  it("draws paths, the robot and handles in night ink, and annotations in a darker blue", () => {
    const ink = liveInk(theme, true);
    expect(ink.pathSelected).toBe("#17061d");
    expect(ink.robotOutline).toBe("#17061d");
    expect(ink.pathEstimated).toBe("#2a1735");
    expect(ink.handleEndpoint).toBe("#17061d");
    expect(ink.canvasAnnotation).toBe("#2f5fa8");
    expect(ink.snapGuide).toBe(ink.canvasAnnotation);
    expect(ink.pathWidthSelectedPx).toBeGreaterThan(ink.pathWidthNormalPx);
  });

  it("leaves severity, alliance and the corner readout colours as the tokens give them", () => {
    const ink = liveInk(theme, true);
    for (const key of ["sevError", "sevWarn", "sevInfo", "allianceRed", "allianceBlue", "textLo", "highlightFind"] as const) {
      expect(ink[key]).toBe(theme[key]);
      expect(key in LIGHT_FIELD_INK).toBe(false);
    }
  });
});

describe("the ink on the field well", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the fixed chrome tokens, so the light theme's white surfaces and night text never reach the well", () => {
    // The light theme's resolved values: surfaces white, text night, chrome unchanged.
    const light: Record<string, string> = {
      "--text-hi": "#26192c",
      "--text-mid": "#55475c",
      "--text-lo": "#6b5d71",
      "--bg-raised": "#ffffff",
      "--border-default": "#e6dce9",
      "--border-strong": "#8e7c96",
      "--chrome-text-hi": "#faf6fb",
      "--chrome-text-mid": "#c2b0c8",
      "--chrome-text-lo": "#a08fa8",
      "--chrome-active": "#2a1735",
      "--chrome-border": "#331e3f",
      "--chrome-border-strong": "#6f5b7c",
    };
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: (name: string) => light[name] ?? "" }));
    const theme = readTheme({} as Element);
    expect(theme.textHi).toBe("#faf6fb");
    expect(theme.textMid).toBe("#c2b0c8");
    expect(theme.textLo).toBe("#a08fa8");
    expect(theme.bgRaised).toBe("#2a1735");
    expect(theme.borderDefault).toBe("#331e3f");
    expect(theme.borderStrong).toBe("#6f5b7c");
  });
});
