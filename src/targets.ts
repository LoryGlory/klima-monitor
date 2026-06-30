import type { Target, CheckResult } from "./types.js";

/**
 * Targets for the personal AC stock alert (DE retailers, June 2026 peak season).
 *
 * Method picks per retailer, learned from smoke-testing:
 *  - Klimaworld: render. Its JSON-LD lies — markup says InStock even when the page
 *    shows "Nicht vorrätig" + an "Alternative Produkte" button. We trust the visible
 *    UI text instead. Note: Klimaworld is a consultative seller — "InStock" here
 *    means "call 0151 46 85 22 91 to order".
 *  - MediaMarkt: render. Cloudflare + JS-rendered availability. Selector-based
 *    parse — the page body contains "In den Warenkorb" inside related-product
 *    carousels, which would create false positives if we scanned the whole body.
 *  - DeLonghi direct: jsonld. Clean schema.org markup with reliable availability.
 *
 * Dropped from v1 (can re-add later):
 *  - Otto: bot-detected at browser level — Playwright gets a blank page.
 *  - Galaxus.de: HTTP/2 protocol-level rejection of automation (plain fetch =
 *    403; Playwright = ERR_HTTP2_PROTOCOL_ERROR). Same league as Otto, needs
 *    stealth tooling not worth adding for personal use.
 *  - Kaufland: HTTP 403 on plain fetch; marketplace rarely stocks these anyway.
 *  - Expert.de: gated by Cookiebot consent — works but needs careful selector tuning.
 */

/**
 * Pull the first DE-formatted euro price out of body text, e.g. "1.099,00 €".
 * German number format: "." = thousands separator, "," = decimal separator.
 * Returns null if no price found.
 */
function extractGermanPrice(text: string): number | null {
  const m = /(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})\s*€/.exec(text);
  if (!m) return null;
  return Number(m[1].replaceAll(".", "") + "." + m[2]);
}

/** Klimaworld-specific: their UI explicitly distinguishes vorrätig vs nicht vorrätig. */
function parseKlimaworldText(text: string): CheckResult {
  const t = text.toLowerCase();
  const price = extractGermanPrice(text);
  // Explicit OOS markers Klimaworld uses on its product pages.
  if (/nicht vorrätig|lieferzeit anfragen|alternative produkte|ausverkauft/.test(t)) {
    return { availability: "OutOfStock", price };
  }
  // Positive marker — note: Klimaworld is a consultative seller (phone/email order)
  // so "InStock" here means "Klimaworld has inventory; call to order".
  if (/auf lager|sofort verfügbar|sofort lieferbar/.test(t)) {
    return { availability: "InStock", price };
  }
  return { availability: "Unknown", price };
}

/**
 * Generic DE Baumarkt (Hornbach / OBI / Bauhaus / toom) parser. These chains
 * don't put items in floating carousels the way MediaMarkt does, so body-text
 * matching is reliable. Conservative — leans toward "Unknown" if the signal
 * isn't crisp, to avoid false-positive Telegram noise.
 */
function parseBaumarktText(text: string): CheckResult {
  const t = text.toLowerCase();
  // Strong OOS markers Baumärkte use:
  //  - "online nicht bestellbar" / "nur reservierung" (Hornbach + OBI flag this
  //    when a product can be viewed in-store but not shipped)
  //  - "derzeit nicht möglich" — OBI's wording for "no home delivery, no
  //    pickup either" (verified: bare "In den Warenkorb" button still appears
  //    on the page even when this is true, so we MUST check this first)
  //  - generic OOS strings
  if (/online nicht bestellbar|nur zur reservierung|nur reservierung|reservierung im markt|nicht im sortiment|nicht verfügbar|nicht lieferbar|ausverkauft|leider keine lieferung|momentan nicht|derzeit nicht möglich|benachrichtigen sobald verfügbar|benachrichtige mich/.test(t)) {
    return { availability: "OutOfStock" };
  }
  // Strong InStock markers — "In den Warenkorb" is the cart button text on all
  // three. "Online bestellen" + "sofort lieferbar" are common too.
  if (/in den warenkorb|online bestellen|sofort lieferbar|jetzt online kaufen|lieferbar in \d/.test(t)) {
    return { availability: "InStock" };
  }
  return { availability: "Unknown" };
}

/**
 * MediaMarkt encodes availability in the data-test attribute itself:
 *   mms-cofr-delivery_AVAILABLE           → InStock, normal delivery
 *   mms-cofr-delivery_PARTIALLY_AVAILABLE → InStock but later/regional delivery
 *   mms-cofr-delivery_NOT_AVAILABLE       → OutOfStock
 * This is more reliable than text matching — survives copy changes, can't be
 * fooled by related-product carousels containing "In den Warenkorb" elsewhere.
 * Also pulls the price and delivery promise so the Telegram alert can include
 * them (price matters: a third-party seller may show InStock at 2× retail).
 */
async function checkMediaMarkt(
  page: import("playwright").Page,
): Promise<CheckResult> {
  const handle = await page.$("[data-test^='mms-cofr-delivery']");
  if (!handle) return { availability: "Unknown", note: "no delivery widget" };

  const dataTest = (await handle.getAttribute("data-test")) ?? "";
  const deliveryText = (await handle.innerText().catch(() => ""))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  // Price block — handle both branded-price and regular cofr-price layouts.
  const rawPrice = await page
    .locator("[data-test='cofr-price'], [data-test*='branded-price']")
    .first()
    .innerText()
    .catch(() => "");
  // MM renders prices like "559, 99 €" with non-breaking spaces and commas —
  // pull the first euro number to a normal float.
  const priceMatch = /(\d+),(\d{2})/.exec(rawPrice.replace(/\s/g, ""));
  const price = priceMatch ? Number(`${priceMatch[1]}.${priceMatch[2]}`) : null;

  // Marketplace third-party indicator — "Verkauf und Versand durch <X>" means
  // it's not MM's own stock. Often massively overpriced. Worth surfacing in alerts.
  const isThirdParty = /verkauf und versand durch /i.test(rawPrice);

  const note =
    `${deliveryText}${isThirdParty ? " · marketplace seller" : ""}`.trim() ||
    undefined;

  if (dataTest.endsWith("_NOT_AVAILABLE")) {
    return { availability: "OutOfStock", price, note };
  }
  if (dataTest.endsWith("_AVAILABLE") || dataTest.endsWith("_PARTIALLY_AVAILABLE")) {
    return { availability: "InStock", price, note };
  }
  return { availability: "Unknown", price, note: `${note ?? ""} · ${dataTest}`.trim() };
}

export const targets: Target[] = [
  // =========================================================================
  // PRIORITY 1: Midea PortaSplit (~700–1100€) — the model the user actually wants
  // =========================================================================
  {
    id: "klimaworld-portasplit",
    retailer: "Klimaworld",
    product: "Midea PortaSplit 3.5 kW (call 0151 46 85 22 91)",
    url: "https://www.klimaworld.com/products/midea-portasplit-mobile-split-klimaanlage-3-5-kw30038",
    method: "render",
    parseText: parseKlimaworldText,
  },
  {
    id: "mediamarkt-portasplit-cool",
    retailer: "MediaMarkt",
    product: "Midea PortaSplit Cool 8000 BTU",
    url: "https://www.mediamarkt.de/de/product/_midea-portasplit-cool-split-klimaanlage-weissgrau-max-raumgrosse-70-m-3035466.html",
    method: "render",
    check: checkMediaMarkt,
  },
  {
    // Saturn is the same MediaMarktSaturn platform — `mms-cofr-delivery_*` data-test
    // confirmed identical to MM. Separate regional inventory pools though, so worth
    // tracking even when the article number matches MM.
    id: "saturn-portasplit-35",
    retailer: "Saturn",
    product: "Midea PortaSplit 3.5 kW",
    url: "https://www.saturn.de/de/product/_midea-portasplit-split-klimaanlage-mondweiss-max-raumgrosse-105-m-3035465.html",
    method: "render",
    check: checkMediaMarkt,
  },
  {
    id: "saturn-portasplit-cool",
    retailer: "Saturn",
    product: "Midea PortaSplit Cool 8000 BTU",
    url: "https://www.saturn.de/de/product/_midea-portasplit-cool-mobile-split-klimaanlage-8000btu-mobile-split-klimaanlage-weiss-max-raumgrosse-28-m-eek-a-179209322.html",
    method: "render",
    check: checkMediaMarkt,
  },
  {
    // Standard PortaSplit (42 m², article 142245268) — different listing than
    // the 105 m³ one above. Same model, MM/Saturn list multiple SKU variants.
    id: "saturn-portasplit-42",
    retailer: "Saturn",
    product: "Midea PortaSplit 42 m²",
    url: "https://www.saturn.de/de/product/_midea-porta-split-klimaanlage-grau-max-raumgrosse-42-m-eek-a-142245268.html",
    method: "render",
    check: checkMediaMarkt,
  },
  // Hornbach Midea PortaSplit URL dropped — agent-found URL returns Hornbach's
  // "Moment, da fehlt was!" 404 page. Would need to refind a current product URL.
  {
    id: "obi-portasplit",
    retailer: "OBI",
    product: "Midea PortaSplit",
    url: "https://www.obi.de/p/8620890/midea-mobile-split-klimaanlage-portasplit",
    method: "render",
    parseText: parseBaumarktText,
  },
  // Bauhaus dropped — its cookie wall renders post-domcontentloaded faster than
  // we can dismiss and the product detail isn't visible to our body-text
  // snapshot. Worth revisiting with a dedicated wait-for-cookie-modal step.

  // =========================================================================
  // PRIORITY 2: Comfee MPPH-09CRN7 (~250–550€) — cheap, often stocked
  // =========================================================================
  {
    id: "klimaworld-comfee-9crn7",
    retailer: "Klimaworld",
    product: "Comfee MPPHA-09CRN7 2.6 kW (call 0151 46 85 22 91)",
    url: "https://www.klimaworld.com/products/comfee-mobile-klimaanlage-mppha-09crn7-2-6-kw-9000-btu-h",
    method: "render",
    parseText: parseKlimaworldText,
  },
  {
    id: "mediamarkt-comfee-9crn7",
    retailer: "MediaMarkt",
    product: "Comfee MPPH-09CRN7",
    url: "https://www.mediamarkt.de/de/product/_comfee-mpph-09crn7-2487059.html",
    method: "render",
    check: checkMediaMarkt,
  },
  {
    id: "saturn-comfee-9crn7",
    retailer: "Saturn",
    product: "Comfee MPPH-09CRN7",
    url: "https://www.saturn.de/de/product/_comfee-mpph-09crn7-mobiles-klimager%C3%A4t-wei%C3%9F-max-96172350.html",
    method: "render",
    check: checkMediaMarkt,
  },
  // =========================================================================
  // PRIORITY 3: De'Longhi Pinguino (~370–900€) — premium fallback
  // =========================================================================
  {
    id: "delonghi-direct-pacex93",
    retailer: "De'Longhi (direct)",
    product: "Pinguino Extreme PAC EX93",
    url: "https://www.delonghi.com/de-de/p/mobile-klimagerate-pinguino-extreme-mobiles-klimagerat-pacex93extreme/PACEX93EXTREME.html?pid=0151454025",
    method: "jsonld",
  },
  {
    id: "mediamarkt-delonghi-pacem90",
    retailer: "MediaMarkt",
    product: "De'Longhi PAC EM90 Silent",
    url: "https://www.mediamarkt.de/de/product/_delonghi-pac-em90-silent-2715591.html",
    method: "render",
    check: checkMediaMarkt,
  },
  {
    id: "saturn-delonghi-pacem90",
    retailer: "Saturn",
    product: "De'Longhi PAC EM90 Silent",
    url: "https://www.saturn.de/de/product/_delonghi-pac-em90-silent-2715591.html",
    method: "render",
    check: checkMediaMarkt,
  },
];
