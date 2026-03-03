import { readMigrationFiles } from "drizzle-orm/migrator";
import { join } from "node:path";

const migrations = readMigrationFiles({ migrationsFolder: "./drizzle/" });

await Bun.write(join(import.meta.dir, "./migrations.json"), JSON.stringify(migrations));

console.log("Migrations compiled!");
