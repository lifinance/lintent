import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

export type Db = ReturnType<typeof drizzle>;

let db: Db | undefined;
let initPromise: Promise<Db> | null = null;

const DDL = `
CREATE TABLE IF NOT EXISTS intents (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL UNIQUE,
  vm            TEXT NOT NULL,
  settler       TEXT NOT NULL,
  data          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS fill_transactions (
  id            TEXT PRIMARY KEY,
  output_hash   TEXT NOT NULL UNIQUE,
  tx_hash       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fill_records (
  id            TEXT PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,
  data          TEXT NOT NULL
);
`;

export async function getDb(): Promise<Db> {
  if (db) return db;
  if (typeof window === "undefined") {
    throw new Error("PGlite is only available in the browser");
  }
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const pglite = new PGlite("idb://lintent-orders-v2");
    const instance = drizzle(pglite);
    await pglite.exec(DDL);
    await pglite.exec(`
      ALTER TABLE intents ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
    `);
    db = instance;
    return instance;
  })().catch((err) => {
    initPromise = null;
    throw err;
  });

  return initPromise;
}
