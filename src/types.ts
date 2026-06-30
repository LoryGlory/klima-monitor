export type Availability = "InStock" | "OutOfStock" | "Unknown";

export interface CheckResult {
  availability: Availability;
  price?: number | null;
  /** Optional human note, e.g. which branch, delivery date. */
  note?: string;
}

/**
 * A target is one product at one retailer. `method` decides how we read it:
 *  - 'api'    : hit an internal JSON endpoint (preferred — fast, robust)
 *  - 'jsonld' : parse schema.org JSON-LD embedded in the product page
 *  - 'render' : last resort, render with Playwright and read DOM/text
 */
export interface Target {
  id: string;              // stable unique key, used for state storage
  retailer: string;
  product: string;         // e.g. "PortaSplit Cool" / "PortaSplit 3.5kW"
  url: string;             // human-facing product URL (used in the alert)
  method: "api" | "jsonld" | "render";

  /** For 'api': the endpoint to fetch (may differ from the human url). */
  endpoint?: string;
  /** For 'api': turn the parsed JSON into a CheckResult. */
  parseApi?: (json: any) => CheckResult;

  /** For 'render': CSS selector whose presence/text signals stock. */
  selector?: string;
  /** For 'render': given the selector's text (or whole body), decide. */
  parseText?: (text: string) => CheckResult;
  /**
   * For 'render': custom check that gets the Playwright Page directly — use when
   * the signal lives in attributes (e.g. MediaMarkt encodes state in a
   * `data-test^='mms-cofr-delivery'` attribute), not in visible text. If
   * provided, takes precedence over selector + parseText.
   */
  check?: (page: import("playwright").Page) => Promise<CheckResult>;
}
