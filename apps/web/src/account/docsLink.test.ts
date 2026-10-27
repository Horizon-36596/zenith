import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCS_URL, LIBRARIES_DOC, SCHOOL_GUIDE_URL, TERMS_URL, docsLink } from "./config";

const PUBLIC = "https://libraries.horizon36596.org/zenith/";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the docs link", () => {
  it("points at the public docs site unless the build says otherwise", () => {
    expect(DOCS_URL).toBe(PUBLIC);
    expect(docsLink()).toBe(PUBLIC);
    expect(docsLink("editor/#keyboard-reference")).toBe(`${PUBLIC}editor/#keyboard-reference`);
    expect(docsLink("/editor/")).toBe(`${PUBLIC}editor/`);
  });

  it("builds every other docs link from the same address", () => {
    expect(SCHOOL_GUIDE_URL).toBe(`${PUBLIC}school-admin-guide/`);
    expect(TERMS_URL).toBe(`${PUBLIC}terms/`);
    expect(LIBRARIES_DOC).toBe(`${PUBLIC}command-libraries/`);
  });

  it("follows VITE_DOCS_URL at build time, so a build can serve its own copy", async () => {
    vi.stubEnv("VITE_DOCS_URL", "/docs/");
    vi.resetModules();
    const config = await import("./config");
    expect(config.DOCS_URL).toBe("/docs/");
    expect(config.docsLink("editor/")).toBe("/docs/editor/");
    expect(config.TERMS_URL).toBe("/docs/terms/");
  });

  it("adds the closing slash a build forgot, and ignores a blank value", async () => {
    vi.stubEnv("VITE_DOCS_URL", "/docs");
    vi.resetModules();
    expect((await import("./config")).DOCS_URL).toBe("/docs/");
    vi.stubEnv("VITE_DOCS_URL", "  ");
    vi.resetModules();
    expect((await import("./config")).DOCS_URL).toBe(PUBLIC);
  });
});
