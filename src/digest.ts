import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import { targets } from "./targets.js";
import { checkTarget, closeBrowser } from "./fetcher.js";
import { sendTelegram } from "./notify.js";

/**
 * Daily digest: poll every target once, send a single Telegram message
 * summarizing the current state. Different from the cron check loop —
 * this never fires restock alerts. The point is liveness ("tracker still
 * running") + a daily market temperature read.
 */
async function runDigest() {
  const stamp = new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" });
  console.log(`[${stamp}] digest — checking ${targets.length} targets`);

  const lines: string[] = [];
  for (const target of targets) {
    await sleep(2_000); // be polite between requests
    const result = await checkTarget(target);
    const price = result.price != null ? ` ${result.price.toFixed(0)}€` : "";
    let icon: string;
    if (result.availability === "InStock") icon = "🟢";
    else if (result.availability === "OutOfStock") icon = "🔴";
    else icon = "❓";
    const noteTail = result.note ? ` <i>(${result.note.replaceAll(/<|>/g, "")})</i>` : "";
    lines.push(`${icon} <b>${target.retailer}</b> — ${target.product}${price}${noteTail}`);
    console.log(`  ${icon} ${target.retailer} ${result.availability}${price}`);
  }

  const cap = process.env.MAX_PRICE_EUR ?? "(no cap)";
  const html =
    `<b>klima-monitor daily digest</b>\n<i>${stamp}</i>\n\n` +
    lines.join("\n") +
    `\n\n<i>MAX_PRICE_EUR = ${cap} €</i>`;

  const ok = await sendTelegram(html);
  console.log(ok ? "Digest sent." : "Digest send failed (no Telegram config?).");
  await closeBrowser();
}

runDigest().catch((e) => {
  console.error(e);
  process.exit(1);
});
