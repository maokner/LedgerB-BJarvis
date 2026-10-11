import { describe, expect, it } from "vitest";
import { createAmazonMerchant, parseStorageState } from "../src/amazon/browser.js";
import {
  desktopUserAgent, detectBlock, findItemCount, findItemsSubtotal, findOrderId, findOrderTotal, isCheckoutUrl, isThankYouUrl, newestOrderFor, parseCents,
  signedInName, titleShown, toProducts, type RawResult,
} from "../src/amazon/pages.js";

describe("Amazon page parsing", () => {
  it("reads prices as cents", () => {
    expect(parseCents("$12.34")).toBe(1234);
    expect(parseCents(" $1,234.56 ")).toBe(123456);
    expect(parseCents("$0.99")).toBe(99);
    expect(parseCents("7.00")).toBe(700);
    for (const bad of ["", "See options", "$12", "$12.3", "$12.34 - $20.00", null, undefined]) expect(parseCents(bad)).toBeNull();
  });

  it("finds an order number", () => {
    expect(findOrderId("Order placed, thanks!\nOrder # 114-3941689-8772232\nShipping to Matt")).toBe("114-3941689-8772232");
    expect(findOrderId("Order #D01-1234567-1234567 is digital")).toBeUndefined();
    expect(findOrderId("Call 1-800-123-4567")).toBeUndefined();
  });

  it("finds the order total, not the subtotal or the total before tax", () => {
    const spc = "Items:\t$14.39\nShipping & handling:\t$0.00\nTotal before tax:\t$14.39\nEstimated tax to be collected:\t$1.33\nOrder total:\t$15.72";
    expect(findOrderTotal(spc)).toBe(1572);
    expect(findOrderTotal("Order Total: $1,015.72")).toBe(101572);
    expect(findOrderTotal("Grand total:\n$9.99")).toBe(999);
    // The Buy Now side sheet: a bare "Total" line.
    expect(findOrderTotal("Arriving tomorrow\nItems total $14.39\nTotal before tax $14.39\nTotal\n$15.72")).toBe(1572);
    expect(findOrderTotal("Total before tax: $14.39\nItems total: $14.39")).toBeNull();
    expect(findOrderTotal("nothing here")).toBeNull();
  });

  it("finds the items subtotal and the item count", () => {
    expect(findItemsSubtotal("Items:\t$14.39\nOrder total:\t$15.72")).toBe(1439);
    expect(findItemsSubtotal("Items (2):\t$28.78")).toBe(2878);
    expect(findItemsSubtotal("Subtotal (1 item): $14.39")).toBe(1439);
    expect(findItemCount("Checkout (1 item)")).toBe(1);
    expect(findItemCount("Checkout ( 3 items )")).toBe(3);
    expect(findItemCount("Items (2):\t$28.78")).toBe(2);
    expect(findItemCount("Subtotal (4 items): $40.00")).toBe(4);
    expect(findItemCount("Order total: $15.72")).toBeNull();
  });

  it("detects a captcha or a sign-in wall", () => {
    expect(detectBlock("https://www.amazon.com/errors/validateCaptcha", "")).toBe("captcha");
    expect(detectBlock("https://www.amazon.com/s?k=gum", "<h4>Enter the characters you see below</h4>")).toBe("captcha");
    expect(detectBlock("https://www.amazon.com/", "<p>Sorry, we just need to make sure you're not a robot.</p>")).toBe("captcha");
    expect(detectBlock("https://www.amazon.com/ap/signin?openid.return_to=x", "")).toBe("signin");
    expect(detectBlock("https://www.amazon.com/ax/claim?arb=1", "")).toBe("signin");
    expect(detectBlock("https://www.amazon.com/gp/buy/spc/handlers/display.html", '<form name="signIn" method="post">')).toBe("signin");
    expect(detectBlock("https://www.amazon.com/s?k=gum", "<div data-component-type=\"s-search-result\">Trident</div>")).toBeUndefined();
  });

  it("reads the nav greeting", () => {
    expect(signedInName("Hello, Matt\nAccount & Lists")).toBe("Matt");
    expect(signedInName("Hello, sign in\nAccount & Lists")).toBeUndefined();
    expect(signedInName("")).toBeUndefined();
  });

  it("tells checkout, thank-you and other pages apart", () => {
    expect(isCheckoutUrl("https://www.amazon.com/checkout/p/p-123/spc?pipelineType=Chewbacca")).toBe(true);
    expect(isCheckoutUrl("https://www.amazon.com/gp/buy/spc/handlers/display.html?hasWorkingJavascript=1")).toBe(true);
    expect(isCheckoutUrl("https://www.amazon.com/gp/buy/thankyou/handlers/display.html")).toBe(false);
    expect(isThankYouUrl("https://www.amazon.com/gp/buy/thankyou/handlers/display.html")).toBe(true);
    expect(isCheckoutUrl("https://www.amazon.com/dp/B0711V757H")).toBe(false);
  });

  it("matches a truncated checkout title", () => {
    const title = "Trident Original Sugar Free Gum, 12 Packs of 14 Pieces (168 Total Pieces)";
    expect(titleShown("Arriving Oct 12\nTrident Original Sugar Free Gum, 12 Packs...\n$14.39", title)).toBe(true);
    expect(titleShown("Anker USB-C Cable\n$12.99", title)).toBe(false);
  });

  it("takes the newest order's number from Your Orders only when it is this item", () => {
    const history = "ORDER PLACED\nOctober 11, 2026\nORDER # 114-0000001-0000001\nTrident Original Sugar Free Gum, 12 Packs\nORDER PLACED\nOctober 1\nORDER # 114-0000002-0000002\nAnker cable";
    expect(newestOrderFor(history, "Trident Original Sugar Free Gum, 12 Packs of 14 Pieces")).toBe("114-0000001-0000001");
    expect(newestOrderFor(history, "Anker cable")).toBeUndefined();
    expect(newestOrderFor("No orders", "Anker cable")).toBeUndefined();
  });

  it("turns search cards into products: organic only, brand in front, unpriced kept", () => {
    const card = (over: Partial<RawResult>): RawResult => ({ asin: "B0711V757H", titles: [], priceText: null, rating: null, ratingCount: null, sponsored: false, ...over });
    const products = toProducts([
      card({ asin: "B0SPONSOR1", titles: ["Ad gum"], priceText: "$1.00", sponsored: true }),
      card({ titles: ["Trident", "Original Sugar Free Gum, 12 Packs", "Original  Sugar Free Gum, 12 Packs"], priceText: "$14.39", rating: "4.8 out of 5 stars, rating details", ratingCount: "6,329 ratings" }),
      card({ titles: ["Trident", "Duplicate"] }),
      card({ asin: "", titles: ["No asin"] }),
      card({ asin: "B0OPTIONS1", titles: ["Trident Gum Variety Pack"] }),
    ]);
    expect(products).toEqual([
      { asin: "B0711V757H", title: "Trident Original Sugar Free Gum, 12 Packs", priceCents: 1439, url: "https://www.amazon.com/dp/B0711V757H", rating: "4.8 out of 5 stars, 6,329 ratings" },
      { asin: "B0OPTIONS1", title: "Trident Gum Variety Pack", priceCents: null, url: "https://www.amazon.com/dp/B0OPTIONS1" },
    ]);
  });

  it("presents as desktop Chrome with the browser's major version", () => {
    expect(desktopUserAgent("156.0.8078.4")).toContain("Chrome/156.0.0.0 Safari/537.36");
    expect(desktopUserAgent("156.0.8078.4")).toContain("Macintosh");
  });
});

describe("Amazon storage state", () => {
  const state = '{"cookies":[{"name":"session-id","value":"1","domain":".amazon.com","path":"/","expires":-1,"httpOnly":false,"secure":true,"sameSite":"Lax"}],"origins":[]}';

  it("accepts raw JSON or base64 of it", () => {
    expect(parseStorageState(state).cookies).toHaveLength(1);
    expect(parseStorageState(Buffer.from(state).toString("base64")).cookies).toHaveLength(1);
    expect(parseStorageState(`  ${state}\n`).cookies).toHaveLength(1);
  });

  it("refuses anything else at creation, before any browser starts", () => {
    expect(() => createAmazonMerchant({ storageState: "not json", limitCents: 2000 })).toThrow(/not valid JSON/);
    expect(() => createAmazonMerchant({ storageState: '{"origins":[]}', limitCents: 2000 })).toThrow(/no cookies/);
    expect(createAmazonMerchant({ storageState: state, limitCents: 2000 }).name).toBe("Amazon");
  });
});
