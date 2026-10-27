/**
 * The links the app shows keep `?cloud=fake` when the page runs the fake cloud from its address, so
 * an invite or a share link opened in the same browser opens in the same fake cloud (the owner's test
 * walk). The real cloud's links carry no query.
 */
import { describe, expect, it } from "vitest";
import { joinLink } from "../account/invites";
import { parseShareHash, shareLink, shareLinkBase } from "./shareModel";

describe("links in the fake cloud", () => {
  it("keep ?cloud=fake from the page's address, and nothing else", () => {
    expect(joinLink("AbCdEfGhIjKlMnOpQrStUv", "http://localhost:5174/?cloud=fake#/x")).toBe(
      "http://localhost:5174/?cloud=fake#/join/AbCdEfGhIjKlMnOpQrStUv",
    );
    expect(joinLink("AbCdEfGhIjKlMnOpQrStUv", "https://zenith.horizon36596.org/?utm=x#/x")).toBe(
      "https://zenith.horizon36596.org/#/join/AbCdEfGhIjKlMnOpQrStUv",
    );
    const secret = "WXqKCS2f4RXdU9IiBJEOcA";
    const fake = shareLink(secret, shareLinkBase({ origin: "http://localhost:5174", search: "?cloud=fake" }, "/"));
    expect(fake).toBe(`http://localhost:5174/?cloud=fake#/s/${secret}`);
    expect(parseShareHash(new URL(fake).hash)).toBe(secret);
    expect(shareLink(secret, shareLinkBase({ origin: "https://zenith.horizon36596.org", search: "" }, "/"))).toBe(
      `https://zenith.horizon36596.org/#/s/${secret}`,
    );
    expect(shareLink(secret, shareLinkBase({ origin: "https://libraries.horizon36596.org", search: "" }, "/zenith/app/"))).toBe(
      `https://libraries.horizon36596.org/zenith/app/#/s/${secret}`,
    );
  });
});
