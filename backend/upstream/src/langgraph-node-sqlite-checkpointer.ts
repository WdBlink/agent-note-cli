import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  TASKS,
  WRITES_IDX_MAP,
  copyCheckpoint,
  maxChannelVersion,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol
} from "@langchain/langgraph-checkpoint";

interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  type: string | null;
  checkpoint: string | Uint8Array;
  metadata: string | Uint8Array;
  pending_writes: string | Uint8Array | null;
  pending_sends: string | Uint8Array | null;
}

interface PendingWriteRow {
  task_id: string;
  channel: string;
  type: string | null;
  value: string | null;
}

interface PendingSendRow {
  type: string | null;
  value: string | null;
}

const CHECKPOINT_METADATA_KEYS = new Set(["source", "step", "parents"]);
const INPUT_ITEM = "__workflow_input__";
const RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * LangGraph's official SQLite saver uses better-sqlite3. This adapter keeps
 * the same BaseCheckpointSaver contract but uses Node's built-in SQLite,
 * avoiding architecture-specific npm binaries in the universal Electron app.
 * Its schema and pending-write behavior follow the upstream saver.
 */
export class NodeSqliteSaver extends BaseCheckpointSaver {
  private initialized = false;
  private readonly database: DatabaseSync;
  private withoutCheckpoint?: StatementSync;
  private withCheckpoint?: StatementSync;
  private readonly activeThreads = new Set<string>();

  constructor(database: DatabaseSync, serde?: SerializerProtocol) {
    super(serde);
    this.database = database;
  }

  static fromConnectionString(connectionStringOrPath: string): NodeSqliteSaver {
    const filename = sqliteFilename(connectionStringOrPath);
    return new NodeSqliteSaver(new DatabaseSync(filename));
  }

  close(): void {
    this.database.close();
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.setup();
    const threadId = stringConfig(config, "thread_id");
    if (!threadId) throw new Error("Missing thread_id field in config.configurable.");
    const checkpointNamespace = stringConfig(config, "checkpoint_ns") ?? "";
    const checkpointId = stringConfig(config, "checkpoint_id");
    const row = (checkpointId
      ? this.withCheckpoint!.get(threadId, checkpointNamespace, checkpointId)
      : this.withoutCheckpoint!.get(threadId, checkpointNamespace)) as CheckpointRow | undefined;
    if (!row) return undefined;
    return this.rowToTuple(row, config, checkpointId);
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    this.setup();
    const where: string[] = [];
    const parameters: Array<string | number> = [];
    const threadId = stringConfig(config, "thread_id");
    const checkpointNamespace = stringConfig(config, "checkpoint_ns");
    if (threadId) {
      where.push("thread_id = ?");
      parameters.push(threadId);
    }
    if (checkpointNamespace !== undefined) {
      where.push("checkpoint_ns = ?");
      parameters.push(checkpointNamespace);
    }
    const beforeId = stringConfig(options?.before, "checkpoint_id");
    if (beforeId) {
      where.push("checkpoint_id < ?");
      parameters.push(beforeId);
    }
    for (const [key, value] of Object.entries(options?.filter ?? {})) {
      if (value === undefined || !CHECKPOINT_METADATA_KEYS.has(key)) continue;
      where.push(`json_extract(CAST(metadata AS TEXT), '$.${key}') = json(?)`);
      parameters.push(JSON.stringify(value));
    }
    const limit = normalizeLimit(options?.limit);
    const sql = `${checkpointSelectSql()}
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY checkpoint_id DESC
      ${limit ? `LIMIT ${limit}` : ""}`;
    const rows = this.database.prepare(sql).all(...parameters) as unknown as CheckpointRow[];
    for (const row of rows) yield await this.rowToTuple(row, config, row.checkpoint_id);
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    this.setup();
    const threadId = stringConfig(config, "thread_id");
    if (!threadId) throw new Error('Missing "thread_id" field in config.configurable.');
    const checkpointNamespace = stringConfig(config, "checkpoint_ns") ?? "";
    const parentCheckpointId = stringConfig(config, "checkpoint_id") ?? null;
    const prepared = copyCheckpoint(checkpoint);
    prepared.channel_values = { ...prepared.channel_values };
    for (const channel of ["input", "__start__"]) {
      if (channel in prepared.channel_values) prepared.channel_values[channel] = await this.storeInputChannel(threadId, channel, prepared.channel_values[channel]);
    }
    const [[checkpointType, checkpointBytes], [metadataType, metadataBytes]] = await Promise.all([
      this.serde.dumpsTyped(prepared),
      this.serde.dumpsTyped(metadata)
    ]);
    if (checkpointType !== metadataType) {
      throw new Error("Checkpoint and metadata serializers returned different storage types.");
    }
    this.database.prepare(`
      INSERT OR REPLACE INTO checkpoints
      (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      threadId,
      checkpointNamespace,
      checkpoint.id,
      parentCheckpointId,
      checkpointType,
      checkpointBytes,
      metadataBytes
    );
    this.touchThread(threadId);
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNamespace,
        checkpoint_id: checkpoint.id
      }
    };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    this.setup();
    const threadId = stringConfig(config, "thread_id");
    const checkpointId = stringConfig(config, "checkpoint_id");
    if (!threadId) throw new Error("Missing thread_id field in config.configurable.");
    if (!checkpointId) throw new Error("Missing checkpoint_id field in config.configurable.");
    const checkpointNamespace = stringConfig(config, "checkpoint_ns") ?? "";
    const serialized = await Promise.all(writes.map(async ([channel, value], index) => {
      const [type, bytes] = await this.serde.dumpsTyped(await this.storeInputChannel(threadId, channel, value));
      return { channel, type, bytes, index: WRITES_IDX_MAP[channel] ?? index };
    }));
    const statement = this.database.prepare(`
      INSERT OR REPLACE INTO writes
      (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.transaction(() => {
      for (const item of serialized) {
        statement.run(
          threadId,
          checkpointNamespace,
          checkpointId,
          taskId,
          item.index,
          item.channel,
          item.type,
          item.bytes
        );
      }
      this.touchThread(threadId);
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    this.setup();
    if (!threadId.trim()) throw new Error("threadId must not be empty.");
    this.transaction(() => {
      this.database.prepare("DELETE FROM writes WHERE thread_id = ?").run(threadId);
      this.database.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(threadId);
      this.database.prepare("DELETE FROM workflow_items WHERE thread_id = ?").run(threadId);
      this.database.prepare("DELETE FROM workflow_threads WHERE thread_id = ?").run(threadId);
    });
  }

  async putWorkflowItem(threadId: string, itemId: string, value: unknown): Promise<void> {
    this.setup();
    if (!threadId.trim() || !itemId.trim()) throw new Error("Workflow item identity must not be empty.");
    const [type, bytes] = await this.serde.dumpsTyped(value);
    this.database.prepare(`
      INSERT OR REPLACE INTO workflow_items (thread_id, item_id, type, value)
      VALUES (?, ?, ?, ?)
    `).run(threadId, itemId, type, bytes);
    this.touchThread(threadId);
  }

  async getWorkflowItem(threadId: string, itemId: string): Promise<unknown | undefined> {
    this.setup();
    const row = this.database.prepare(`
      SELECT type, value FROM workflow_items WHERE thread_id = ? AND item_id = ?
    `).get(threadId, itemId) as { type: string | null; value: string | Uint8Array } | undefined;
    if (row) return this.serde.loadsTyped(row.type ?? "json", blobToString(row.value));
    if (itemId !== INPUT_ITEM) {
      const input = await this.getWorkflowItem(threadId, INPUT_ITEM) as { sessions?: Array<{ session: { sessionId: string } }> } | undefined;
      return input?.sessions?.find((item) => item.session.sessionId === itemId);
    }
    return undefined;
  }

  /** Remove a published run and reclaim bounded WAL/free pages without a blocking full VACUUM. */
  async cleanupCompletedThread(threadId: string): Promise<void> {
    this.setup();
    this.database.prepare(`UPDATE workflow_threads SET completed = 1 WHERE thread_id = ? OR (
      scope = (SELECT scope FROM workflow_threads WHERE thread_id = ?)
      AND revision <= (SELECT revision FROM workflow_threads WHERE thread_id = ?))`).run(threadId, threadId, threadId);
    await this.deleteThread(threadId);
    this.compact();
  }

  compact(): void {
    this.setup();
    this.database.exec("PRAGMA wal_checkpoint(PASSIVE)");
    const mode = this.database.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum?: number } | undefined;
    if (mode?.auto_vacuum === 2) this.database.exec("PRAGMA incremental_vacuum(2048)");
    this.database.exec("PRAGMA optimize");
    this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  private setup(): void {
    if (this.initialized) return;
    const existingTables = this.database.prepare(`
      SELECT count(*) AS count
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).get() as { count: number };
    if (existingTables.count === 0) this.database.exec("PRAGMA auto_vacuum=INCREMENTAL");
    this.database.exec("PRAGMA journal_mode=WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type TEXT,
        checkpoint BLOB,
        metadata BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      );
      CREATE TABLE IF NOT EXISTS writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        type TEXT,
        value BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      );
      CREATE INDEX IF NOT EXISTS writes_thread_checkpoint
        ON writes(thread_id, checkpoint_ns, checkpoint_id);
      CREATE TABLE IF NOT EXISTS workflow_items (
        thread_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        type TEXT,
        value BLOB,
        PRIMARY KEY (thread_id, item_id)
      );
      CREATE TABLE IF NOT EXISTS workflow_threads (
        thread_id TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        scope TEXT,
        revision INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.database.exec(`INSERT OR IGNORE INTO workflow_threads (thread_id, updated_at)
      SELECT thread_id, COALESCE(MAX(CAST((julianday(json_extract(CAST(checkpoint AS TEXT), '$.ts')) - 2440587.5) * 86400000 AS INTEGER)), 0)
      FROM checkpoints WHERE thread_id NOT IN (SELECT thread_id FROM workflow_threads) GROUP BY thread_id`);
    this.withoutCheckpoint = this.database.prepare(`${checkpointSelectSql()}
      WHERE thread_id = ? AND checkpoint_ns = ?
      ORDER BY checkpoint_id DESC LIMIT 1`);
    this.withCheckpoint = this.database.prepare(`${checkpointSelectSql()}
      WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`);
    this.initialized = true;
  }

  beginThread(threadId: string): void {
    this.setup();
    if (this.activeThreads.has(threadId)) throw new Error("Workflow thread is already running.");
    this.activeThreads.add(threadId);
    this.touchThread(threadId);
  }

  async endThread(threadId: string): Promise<void> {
    this.activeThreads.delete(threadId);
    this.database.prepare("UPDATE workflow_threads SET updated_at = ? WHERE thread_id = ?").run(Date.now(), threadId);
    await this.prune();
  }

  async prune(completedThreadIds: string[] = [], now = Date.now()): Promise<string[]> {
    this.setup();
    for (const id of completedThreadIds) this.database.prepare("UPDATE workflow_threads SET completed = 1 WHERE thread_id = ?").run(id);
    const rows = this.database.prepare(`SELECT thread_id, updated_at, completed, scope FROM workflow_threads
      ORDER BY revision DESC, updated_at DESC, thread_id`).all() as Array<{ thread_id: string; updated_at: number; completed: number; scope: string | null }>;
    const scopes = new Set<string>();
    const removed: string[] = [];
    for (const row of rows) {
      const superseded = row.scope !== null && scopes.has(row.scope);
      if (row.scope) scopes.add(row.scope);
      if (this.activeThreads.has(row.thread_id)) continue;
      if (row.completed || row.updated_at < now - RETENTION_MS || superseded) {
        await this.deleteThread(row.thread_id);
        removed.push(row.thread_id);
      }
    }
    if (removed.length) this.compact();
    return removed;
  }

  private touchThread(threadId: string): void {
    this.database.prepare(`INSERT INTO workflow_threads (thread_id, updated_at) VALUES (?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET updated_at = excluded.updated_at`).run(threadId, Date.now());
  }

  private async storeInputChannel(threadId: string, channel: string, value: unknown): Promise<unknown> {
    if (channel !== "input" && channel !== "__start__") return value;
    const input = channel === "input" ? value : (value as { input?: unknown } | null)?.input;
    if (!input || typeof input !== "object" || !("workflowRunId" in input)) return value;
    const [type, bytes] = await this.serde.dumpsTyped(input);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const existing = this.database.prepare("SELECT value FROM workflow_items WHERE thread_id = ? AND item_id = ?")
      .get(threadId, INPUT_ITEM) as { value: Uint8Array } | undefined;
    if (existing && createHash("sha256").update(existing.value).digest("hex") !== hash) {
      throw new Error("Frozen workflow input changed within the same thread.");
    }
    if (!existing) {
      this.database.prepare("INSERT INTO workflow_items (thread_id, item_id, type, value) VALUES (?, ?, ?, ?)").run(threadId, INPUT_ITEM, type, bytes);
      this.touchThread(threadId);
      const scopeInput = input as { artifactId?: string; revision?: number };
      if (scopeInput.artifactId) this.database.prepare("UPDATE workflow_threads SET scope = ?, revision = ? WHERE thread_id = ?")
        .run(`${threadId.includes("-v2-") ? "v2" : "v1"}:${scopeInput.artifactId}`, scopeInput.revision ?? 0, threadId);
    }
    const ref = { __workContinuityInputRef: hash };
    return channel === "input" ? ref : { ...value as object, input: ref };
  }

  private async loadInputChannel(threadId: string, channel: string, value: unknown): Promise<unknown> {
    if (channel !== "input" && channel !== "__start__") return value;
    const ref = (channel === "input" ? value : (value as { input?: unknown } | null)?.input) as { __workContinuityInputRef?: string } | null;
    if (!ref?.__workContinuityInputRef) return value;
    const row = this.database.prepare("SELECT type, value FROM workflow_items WHERE thread_id = ? AND item_id = ?")
      .get(threadId, INPUT_ITEM) as { type: string; value: Uint8Array } | undefined;
    if (!row || createHash("sha256").update(row.value).digest("hex") !== ref.__workContinuityInputRef) {
      throw new Error("Frozen workflow input is missing or corrupt; start a new preparation.");
    }
    const input = await this.serde.loadsTyped(row.type, blobToString(row.value));
    return channel === "input" ? input : { ...value as object, input };
  }

  private async rowToTuple(
    row: CheckpointRow,
    requestedConfig: RunnableConfig,
    requestedCheckpointId: string | undefined
  ): Promise<CheckpointTuple> {
    const config = requestedCheckpointId
      ? requestedConfig
      : {
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns: row.checkpoint_ns,
            checkpoint_id: row.checkpoint_id
          }
        };
    const pendingWrites = await Promise.all(parseJsonArray<PendingWriteRow>(row.pending_writes).map(async (write) => [
      write.task_id,
      write.channel,
      await this.loadInputChannel(row.thread_id, write.channel, await this.serde.loadsTyped(write.type ?? "json", write.value ?? ""))
    ] as [string, string, unknown]));
    const checkpoint = await this.serde.loadsTyped(
      row.type ?? "json",
      blobToString(row.checkpoint)
    ) as Checkpoint;
    for (const channel of ["input", "__start__"]) {
      if (channel in checkpoint.channel_values) checkpoint.channel_values[channel] = await this.loadInputChannel(row.thread_id, channel, checkpoint.channel_values[channel]);
    }
    if (checkpoint.v < 4 && row.parent_checkpoint_id) {
      await this.migratePendingSends(checkpoint, row.thread_id, row.parent_checkpoint_id);
    }
    return {
      config,
      checkpoint,
      metadata: await this.serde.loadsTyped(
        row.type ?? "json",
        blobToString(row.metadata)
      ) as CheckpointMetadata,
      ...(row.parent_checkpoint_id
        ? {
            parentConfig: {
              configurable: {
                thread_id: row.thread_id,
                checkpoint_ns: row.checkpoint_ns,
                checkpoint_id: row.parent_checkpoint_id
              }
            }
          }
        : {}),
      pendingWrites
    };
  }

  private async migratePendingSends(
    checkpoint: Checkpoint,
    threadId: string,
    parentCheckpointId: string
  ): Promise<void> {
    const row = this.database.prepare(`
      SELECT json_group_array(
        json_object('type', type, 'value', CAST(value AS TEXT))
      ) AS pending_sends
      FROM writes
      WHERE thread_id = ? AND checkpoint_id = ? AND channel = ?
      ORDER BY idx
    `).get(threadId, parentCheckpointId, TASKS) as { pending_sends?: string | null } | undefined;
    const pending = parseJsonArray<PendingSendRow>(row?.pending_sends ?? null);
    if (pending.length === 0) return;
    checkpoint.channel_values ??= {};
    checkpoint.channel_values[TASKS] = await Promise.all(
      pending.map((item) => this.serde.loadsTyped(item.type ?? "json", item.value ?? ""))
    );
    checkpoint.channel_versions[TASKS] = Object.keys(checkpoint.channel_versions).length > 0
      ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
      : this.getNextVersion(undefined);
  }

  private transaction(operation: () => void): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      operation();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function checkpointSelectSql(): string {
  return `
    SELECT
      thread_id,
      checkpoint_ns,
      checkpoint_id,
      parent_checkpoint_id,
      type,
      checkpoint,
      metadata,
      (
        SELECT json_group_array(json_object(
          'task_id', pw.task_id,
          'channel', pw.channel,
          'type', pw.type,
          'value', CAST(pw.value AS TEXT)
        ))
        FROM writes AS pw
        WHERE pw.thread_id = checkpoints.thread_id
          AND pw.checkpoint_ns = checkpoints.checkpoint_ns
          AND pw.checkpoint_id = checkpoints.checkpoint_id
      ) AS pending_writes,
      (
        SELECT json_group_array(json_object(
          'type', ps.type,
          'value', CAST(ps.value AS TEXT)
        ))
        FROM writes AS ps
        WHERE ps.thread_id = checkpoints.thread_id
          AND ps.checkpoint_ns = checkpoints.checkpoint_ns
          AND ps.checkpoint_id = checkpoints.parent_checkpoint_id
          AND ps.channel = '${TASKS}'
        ORDER BY ps.idx
      ) AS pending_sends
    FROM checkpoints`;
}

/** Cleanup is maintenance: it must never turn a published artifact into a failed task. */
export async function cleanupPublishedCheckpoint(saver: BaseCheckpointSaver, threadId: string): Promise<void> {
  try {
    if (saver instanceof NodeSqliteSaver) await saver.cleanupCompletedThread(threadId);
    else await saver.deleteThread(threadId);
  } catch {
    console.warn("Checkpoint cleanup deferred until the next maintenance pass.");
  }
}

export async function beginCheckpointRun(saver: BaseCheckpointSaver, threadId: string): Promise<() => Promise<void>> {
  if (!(saver instanceof NodeSqliteSaver)) return async () => {};
  try { await saver.prune(); }
  catch { console.warn("Checkpoint retention maintenance deferred."); }
  saver.beginThread(threadId);
  return async () => {
    try { await saver.endThread(threadId); }
    catch { console.warn("Checkpoint retention maintenance deferred."); }
  };
}

function stringConfig(config: RunnableConfig | undefined, key: string): string | undefined {
  const value = config?.configurable?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sqliteFilename(connectionStringOrPath: string): string {
  if (connectionStringOrPath === ":memory:") return connectionStringOrPath;
  if (connectionStringOrPath.startsWith("file:")) return fileURLToPath(connectionStringOrPath);
  if (!connectionStringOrPath.trim()) throw new Error("SQLite path must not be empty.");
  return connectionStringOrPath;
}

function normalizeLimit(value: CheckpointListOptions["limit"]): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 10_000) {
    throw new Error("Checkpoint list limit must be an integer from 1 to 10000.");
  }
  return parsed;
}

function blobToString(value: string | Uint8Array): string {
  return typeof value === "string" ? value : Buffer.from(value).toString("utf8");
}

function parseJsonArray<T>(value: string | Uint8Array | null): T[] {
  if (value === null) return [];
  const parsed = JSON.parse(blobToString(value)) as unknown;
  return Array.isArray(parsed) ? parsed as T[] : [];
}
