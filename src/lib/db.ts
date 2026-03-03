import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { browser } from "$app/environment";
import type { MigrationConfig } from "drizzle-orm/migrator";
import migrations from "./migrations.json";

// The Drizzle DB instance
export let db: ReturnType<typeof drizzle> | undefined;
let initDbPromise: Promise<ReturnType<typeof drizzle> | undefined> | null = null;

async function migrateDb(instance: ReturnType<typeof drizzle>) {
	// dialect and session will appear to not exist...but they do on the pglite drizzle instance
	// @ts-ignore
	await instance.dialect.migrate(migrations, instance.session, {
		migrationsTable: "drizzle_migrations"
	} satisfies Omit<MigrationConfig, "migrationsFolder">);
}

export async function initDb() {
	if (db) return db;
	if (!browser) return undefined;
	if (initDbPromise) return initDbPromise;

	initDbPromise = (async () => {
		// Open a PGLite database; this will persist to IndexedDB in the browser
		const pglite = new PGlite("idb://orders");

		// Create a Drizzle instance over the opened SQLite-compatible database
		db = drizzle(pglite);

		// Run migrations so tables are created on first load
		await migrateDb(db);

		return db;
	})().catch((error) => {
		initDbPromise = null;
		throw error;
	});

	return initDbPromise;
}

export default initDb;
