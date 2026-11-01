import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

/**
 * Runs every migration in Supabase/ in order on startup.
 *
 * Every file is idempotent (`add column if not exists`, `drop constraint if
 * exists`), so re-running on every boot is safe and requires no manual SQL in
 * the dashboard.
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const files = [
      "01-schema.sql",
      "02-rls.sql",
      "03-abuse-prevention.sql",
      "04-reactions.sql",
      "05-invites.sql",
      "06-guild-ownership.sql",
      "07-guild-deletion.sql",
    ];

    for (const file of files) {
      const sql = readFileSync(join(process.cwd(), "Supabase", file), "utf8");
      await pool.query(sql);
      console.log(`[aegis] migration applied: ${file}`);
    }
  } finally {
    await pool.end();
  }
}