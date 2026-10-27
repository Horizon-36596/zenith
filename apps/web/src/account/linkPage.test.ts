/**
 * Links someone else will open (sweep D12): made in the desktop app, whose page is zenith://app/,
 * they point at the public web app; made on the web, they keep the page's own address.
 */
import { describe, expect, it } from "vitest";
import { PUBLIC_APP_URL, isWebPage, linkPageUrl } from "./config";
import { joinLink } from "./invites";
import { shareLink } from "../cloud/shareModel";

describe("links handed out from the desktop app", () => {
  it("point at the public web app instead of zenith://", () => {
    expect(isWebPage("zenith://app/#/library")).toBe(false);
    expect(linkPageUrl("zenith://app/#/library")).toBe(PUBLIC_APP_URL);
    expect(joinLink("AbCdEfGhIjKlMnOpQrStUv", linkPageUrl("zenith://app/"))).toBe(
      "https://zenith.horizon36596.org/#/join/AbCdEfGhIjKlMnOpQrStUv",
    );
    expect(shareLink("s3cr3t", PUBLIC_APP_URL)).toBe("https://zenith.horizon36596.org/#/s/s3cr3t");
  });

  it("keep a web page's own address, so a test build's links stay on it", () => {
    expect(isWebPage("http://localhost:5173/?cloud=fake")).toBe(true);
    expect(linkPageUrl("http://localhost:5173/?cloud=fake#/x")).toBe("http://localhost:5173/?cloud=fake#/x");
    expect(linkPageUrl("https://zenith.horizon36596.org/")).toBe("https://zenith.horizon36596.org/");
    expect(linkPageUrl("https://libraries.horizon36596.org/zenith/app/")).toBe("https://libraries.horizon36596.org/zenith/app/");
  });
});
