import type { Target, CheckResult } from "./types.js";

async function sendTelegram(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  });
  return res.ok;
}

async function sendNtfy(text: string, url: string) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return false;
  const res = await fetch(`https://ntfy.sh/${topic}`, {
    method: "POST",
    headers: {
      Title: "PortaSplit back in stock",
      Priority: "urgent",
      Tags: "snowflake",
      Click: url,
    },
    body: text,
  });
  return res.ok;
}

export async function notifyRestock(target: Target, result: CheckResult) {
  const priceStr = result.price != null ? ` — ${result.price.toFixed(2)} €` : "";
  const noteStr = result.note ? `\n${result.note}` : "";
  const html =
    `🟢 <b>${target.product}</b> in stock at <b>${target.retailer}</b>${priceStr}` +
    `${noteStr}\n${target.url}`;
  const plain = `${target.product} in stock at ${target.retailer}${priceStr}. ${target.url}`;

  const sent = (await sendTelegram(html)) || (await sendNtfy(plain, target.url));
  if (!sent) console.warn("  No notifier configured — set TELEGRAM_* or NTFY_TOPIC in .env");
}
