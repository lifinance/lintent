import { describe, expect, it } from "bun:test";
import { PGlite, MemoryFS } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import migrations from "../src/lib/migrations.json";
import { intents } from "../src/lib/schema";

async function createTestDb() {
	const pglite = new PGlite({ fs: new MemoryFS("testdb") });
	const db = drizzle(pglite);

	// dialect and session will appear to not exist...but they do on the pglite drizzle instance
	// @ts-ignore
	await db.dialect.migrate(migrations, db.session, {
		migrationsTable: "drizzle_migrations"
	});

	return { db, pglite };
}

describe("pglite migrations", () => {
	it("applies migrations and supports upserts", async () => {
		const { db, pglite } = await createTestDb();
		try {
			const now = Date.now();
			await db.insert(intents).values({
				id: "1",
				orderId: "order-1",
				intentType: "escrow",
				data: "{}",
				createdAt: now
			});

			await db
				.insert(intents)
				.values({
					id: "2",
					orderId: "order-1",
					intentType: "escrow",
					data: '{"v":2}',
					createdAt: now
				})
				.onConflictDoUpdate({
					target: intents.orderId,
					set: { data: '{"v":2}' }
				});

			const rows = await db.select().from(intents);
			expect(rows).toHaveLength(1);
			expect(rows[0].data).toBe('{"v":2}');
		} finally {
			await pglite.close();
		}
	});
});
