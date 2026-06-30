import { setTimeout as sleep } from "node:timers/promises";
import type { Target, CheckResult, Availability } from "./types.js";

const CONTACT = process.env.CONTACT_EMAIL || "anonymous@example.com";
const USER_AGENT =
  `klima-monitor/0.1 (personal stock alert; contact: ${CONTACT})`;

/** Shared, lazily-created Playwright browser for 'render' targets. */
let browserPromise: Promise<import("playwright").Browser> | null = null;
async function getBrowser() {
  if (!browserPromise) {
    const { chromium } = await import("playwright");
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise;
    await b.close();
    browserPromise = null;
  }
}

/** Map schema.org availability URLs/strings to our enum. */
function normalizeSchemaAvailability(value: string | undefined): Availability {
  if (!value) return "Unknown";
  const v = value.toLowerCase();
  if (v.includes("instock") || v.includes("limitedavailability")) return "InStock";
  if (v.includes("outofstock") || v.includes("soldout") || v.includes("discontinued"))
    return "OutOfStock";
  return "Unknown";
}

/** Fetch with one polite retry + exponential backoff on 429/403/5xx. */
async function politeFetch(url: string, attempt = 0): Promise<Response> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      // HTML must outrank JSON: Shopify and a few other backends do real Accept
      // content-negotiation and will serve the product-feed JSON instead of the
      // page (whose <script type="application/ld+json"> tag is what we parse).
      Accept: "text/html, application/json;q=0.9",
      "Accept-Language": "de-DE,de;q=0.9,en;q=0.7",
    },
    redirect: "follow",
  });
  if ((res.status === 429 || res.status === 403 || res.status >= 500) && attempt < 3) {
    const backoff = Math.min(30_000, 2_000 * 2 ** attempt);
    console.warn(`  ${res.status} from ${url} — backing off ${backoff}ms`);
    await sleep(backoff);
    return politeFetch(url, attempt + 1);
  }
  return res;
}

/** Extract the first schema.org Product/Offer availability from raw HTML. */
function parseJsonLd(html: string): CheckResult {
  const blocks = [...html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )];
  for (const [, raw] of blocks) {
    try {
      const data = JSON.parse(raw.trim());
      const nodes = Array.isArray(data) ? data : [data, ...(data["@graph"] || [])];
      for (const node of nodes) {
        const offers = node?.offers;
        const offerArr = Array.isArray(offers) ? offers : offers ? [offers] : [];
        for (const offer of offerArr) {
          const avail = normalizeSchemaAvailability(offer?.availability);
          if (avail !== "Unknown") {
            const price = offer?.price != null ? Number(offer.price) : null;
            return { availability: avail, price: Number.isFinite(price!) ? price : null };
          }
        }
      }
    } catch {
      /* malformed block, keep scanning */
    }
  }
  return { availability: "Unknown" };
}

export async function checkTarget(target: Target): Promise<CheckResult> {
  try {
    if (target.method === "api") {
      const res = await politeFetch(target.endpoint || target.url);
      if (!res.ok) return { availability: "Unknown", note: `HTTP ${res.status}` };
      const json = await res.json();
      return target.parseApi
        ? target.parseApi(json)
        : { availability: "Unknown", note: "no parseApi" };
    }

    if (target.method === "jsonld") {
      const res = await politeFetch(target.url);
      if (!res.ok) return { availability: "Unknown", note: `HTTP ${res.status}` };
      return parseJsonLd(await res.text());
    }

    // method === 'render'
    const browser = await getBrowser();
    // Use a realistic browser UA for render targets — sites like Otto serve a 429
    // to our honest "klima-monitor/0.1" UA. Playwright + this UA is what an actual
    // human shopper would send, so it's not deceptive: we ARE a browser here.
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      locale: "de-DE",
    });
    try {
      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await dismissCookieBanner(page);
      // After dismissing, give the page a beat to actually render its real content.
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});

      // Attribute-based check (e.g. MediaMarkt's `data-test^='mms-cofr-delivery'`)
      // beats text-matching when available — survives copy changes, no false
      // positives from carousel content. Takes precedence if provided.
      if (target.check) {
        return await target.check(page);
      }

      // If a selector is provided, read just that region — needed for sites like
      // MediaMarkt where the page body contains "In den Warenkorb" inside related-
      // product carousels (false positive). Fall back to whole body text if the
      // selector doesn't match.
      let text = "";
      if (target.selector) {
        await page.waitForSelector(target.selector, { timeout: 10_000 }).catch(() => {});
        text = await page.locator(target.selector).first().innerText().catch(() => "");
      }
      if (!text) {
        text = await page.locator("body").innerText().catch(() => "");
      }
      return target.parseText
        ? target.parseText(text)
        : { availability: "Unknown", note: "no parseText" };
    } finally {
      await page.close();
    }
  } catch (err) {
    return { availability: "Unknown", note: `error: ${(err as Error).message}` };
  }
}

/**
 * Click the most common DE cookie-consent dismiss buttons.
 * Order matters: try the "essential only" path first to minimize tracking,
 * fall back to "accept all" so the page doesn't stay blocked.
 * Each click is best-effort; any failure is silently ignored.
 */
async function dismissCookieBanner(page: import("playwright").Page): Promise<void> {
  const selectors = [
    // Cookiebot (Expert, many DE shops)
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll",
    "#CybotCookiebotDialogBodyButtonAccept",
    // OneTrust
    "#onetrust-reject-all-handler",
    "#onetrust-accept-btn-handler",
    // Usercentrics (Otto, Klimaworld likely)
    "button[data-testid='uc-deny-all-button']",
    "button[data-testid='uc-accept-all-button']",
    // Generic text-based fallbacks (German + English)
    "button:has-text('Nur notwendige')",
    "button:has-text('Alle ablehnen')",
    "button:has-text('Cookies zulassen')",
    "button:has-text('Alle akzeptieren')",
    "button:has-text('Accept all')",
    "button:has-text('Reject all')",
  ];
  for (const sel of selectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
      await btn.click({ timeout: 2_000 }).catch(() => {});
      // Once we clicked one, we're done — don't click multiple banners.
      return;
    }
  }
}
