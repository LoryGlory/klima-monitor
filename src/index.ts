import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import cron from "node-cron";
import { targets } from "./targets.js";
import { checkTarget, closeBrowser } from "./fetcher.js";
import { getPrevious, saveStatus, isRestock } from "./state.js";
import { notifyRestock } from "./notify.js";
import type { Target, CheckResult } from "./types.js";

const JITTER_SECONDS = Number(process.env.JITTER_SECONDS ?? 20);
const CRON = process.env.CRON ?? "*/3 * * * *";

/** Decide whether a restock event should fire a Telegram alert. */
async function handleRestock(target: Target, result: CheckResult) {
  // Suppress alerts above MAX_PRICE_EUR — see overpriced marketplace listings
  // (e.g. third-party MM sellers at 1949€). null price = unknown, do alert.
  const maxPrice = Number(process.env.MAX_PRICE_EUR) || Infinity;
  if (result.price != null && result.price > maxPrice) {
    console.log(
      `  🔕 RESTOCK at ${target.retailer} suppressed (${result.price.toFixed(2)} € > ${maxPrice} € cap)`,
    );
    return;
  }
  console.log(`  🟢 RESTOCK at ${target.retailer} — notifying`);
  await notifyRestock(target, result);
}

async function runPass() {
  const stamp = new Date().toISOString();
  console.log(`\n[${stamp}] checking ${targets.length} targets`);

  for (const target of targets) {
    // Politeness: small random delay so we don't hit every shop on the exact tick.
    await sleep(Math.random() * JITTER_SECONDS * 1000);

    const prev = getPrevious(target.id);
    const result = await checkTarget(target);

    const priceStr = result.price != null ? ` (${result.price.toFixed(2)} €)` : "";
    console.log(
      `  ${target.retailer} / ${target.product}: ${result.availability}${priceStr}` +
        (result.note ? ` — ${result.note}` : ""),
    );

    if (result.availability !== "Unknown") {
      if (isRestock(prev, result.availability)) {
        await handleRestock(target, result);
      }
      saveStatus(target.id, result.availability, result.price);
    }
  }
  await closeBrowser();
}

async function main() {
  const once = process.argv.includes("--once");
  if (once) {
    await runPass();
    process.exit(0);
  }

  console.log(`klima-monitor started. schedule="${CRON}", targets=${targets.length}`);
  await runPass(); // run immediately on boot, then on schedule

  let busy = false;
  cron.schedule(CRON, async () => {
    if (busy) return; // skip overlapping runs if a pass runs long
    busy = true;
    try {
      await runPass();
    } catch (e) {
      console.error("pass failed:", e);
    } finally {
      busy = false;
    }
  });
}

process.on("SIGINT", async () => {
  await closeBrowser();
  process.exit(0);
});

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
