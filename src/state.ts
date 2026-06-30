import Database from "better-sqlite3";
import type { Availability } from "./types.js";

const db = new Database("state.db");
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS status (
    target_id   TEXT PRIMARY KEY,
    availability TEXT NOT NULL,
    price       REAL,
    updated_at  TEXT NOT NULL
  );
`);

const readStmt = db.prepare("SELECT availability FROM status WHERE target_id = ?");
const upsertStmt = db.prepare(`
  INSERT INTO status (target_id, availability, price, updated_at)
  VALUES (@target_id, @availability, @price, @updated_at)
  ON CONFLICT(target_id) DO UPDATE SET
    availability = excluded.availability,
    price        = excluded.price,
    updated_at   = excluded.updated_at
`);

export function getPrevious(targetId: string): Availability | null {
  const row = readStmt.get(targetId) as { availability: Availability } | undefined;
  return row?.availability ?? null;
}

export function saveStatus(targetId: string, availability: Availability, price?: number | null) {
  upsertStmt.run({
    target_id: targetId,
    availability,
    price: price ?? null,
    updated_at: new Date().toISOString(),
  });
}

/** True only on a genuine restock: previously not-in-stock, now in stock. */
export function isRestock(prev: Availability | null, next: Availability): boolean {
  return next === "InStock" && prev !== "InStock";
}
