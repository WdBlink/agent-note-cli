import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { SessionDigestCandidateSchema, StructuredTodayModelInvocationSchema } from "../../src/structured-today-contracts";
import { normalizeStructuredRun, type StructuredTodayRunRecordV1 } from "./traceink-asset-store";

const DigestSchema = z.object({ output: SessionDigestCandidateSchema, invocation: StructuredTodayModelInvocationSchema }).strict();
type CachedDigest = z.infer<typeof DigestSchema>;

/** Small mutable execution state; immutable review history stays in the asset repository. */
export class StructuredTodayRuntimeStore {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, value TEXT NOT NULL, started_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS digests (key TEXT PRIMARY KEY, value TEXT NOT NULL, used_at INTEGER NOT NULL);`);
  }

  close(): void { this.db.close(); }

  getRun(id: string): StructuredTodayRunRecordV1 | undefined {
    const row = this.db.prepare("SELECT value FROM runs WHERE id = ?").get(id) as { value: string } | undefined;
    if (!row) return undefined;
    const run = normalizeStructuredRun(JSON.parse(row.value));
    if (!run) throw new Error("Stored workflow progress is invalid.");
    return run;
  }

  listRuns(): StructuredTodayRunRecordV1[] {
    const rows = this.db.prepare("SELECT id FROM runs ORDER BY started_at").all() as Array<{ id: string }>;
    return rows.map((row) => this.getRun(row.id)!);
  }

  saveRun(value: StructuredTodayRunRecordV1): void {
    const run = normalizeStructuredRun(value);
    if (!run) throw new Error("Workflow progress is invalid.");
    const previous = this.getRun(run.runId);
    if (previous && previous.kind !== run.kind) throw new Error("Workflow run cannot change kind.");
    this.db.prepare("INSERT OR REPLACE INTO runs VALUES (?, ?, ?)").run(run.runId, JSON.stringify(run), run.startedAt);
    this.db.exec("DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY started_at DESC, rowid DESC LIMIT 200)");
  }

  getDigest(key: string): CachedDigest | undefined {
    const row = this.db.prepare("SELECT value FROM digests WHERE key = ?").get(key) as { value: string } | undefined;
    if (!row) return undefined;
    let value: unknown;
    try { value = JSON.parse(row.value); } catch { /* Corrupt cache entries are recomputed. */ }
    const parsed = DigestSchema.safeParse(value);
    if (!parsed.success) {
      this.db.prepare("DELETE FROM digests WHERE key = ?").run(key);
      return undefined;
    }
    this.db.prepare("UPDATE digests SET used_at = ? WHERE key = ?").run(Date.now(), key);
    return parsed.data;
  }

  saveDigest(key: string, value: CachedDigest): void {
    const serialized = JSON.stringify(DigestSchema.parse(value));
    // Bound cache content to at most 512 * 64 KiB; larger results remain usable without caching.
    if (Buffer.byteLength(serialized) > 65536) return;
    this.db.prepare("INSERT OR REPLACE INTO digests VALUES (?, ?, ?)").run(key, serialized, Date.now());
    this.db.exec("DELETE FROM digests WHERE key NOT IN (SELECT key FROM digests ORDER BY used_at DESC, rowid DESC LIMIT 512)");
  }
}
