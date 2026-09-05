import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createEmptyTraceinkAssetStore,
  normalizeTraceinkAssetStore,
  type TraceinkAssetStoreDocumentV1
} from "./traceink-asset-store";

export const TRACEINK_ASSET_STORE_FILE_NAME = "traceink-assets-v1.json" as const;

export interface TraceinkAssetRepositoryIo {
  readText(filePath: string): Promise<string>;
  ensureDirectory(directoryPath: string): Promise<void>;
  writeNewText(filePath: string, text: string): Promise<void>;
  replaceFile(sourcePath: string, destinationPath: string): Promise<void>;
  removeFile(filePath: string): Promise<void>;
}

export interface TraceinkAssetRepositoryOptions {
  filePath: string;
  io?: TraceinkAssetRepositoryIo;
  temporaryId?: () => string;
  onPublish?: (document: TraceinkAssetStoreDocumentV1) => void;
}

/**
 * Owns the standalone Traceink asset file. Mutations are serialized and the
 * in-memory snapshot advances only after the replacement file is durable from
 * the repository's point of view.
 */
export class TraceinkAssetRepository {
  private readonly io: TraceinkAssetRepositoryIo;
  private readonly temporaryId: () => string;
  private readonly onPublish: ((document: TraceinkAssetStoreDocumentV1) => void) | undefined;
  private published: TraceinkAssetStoreDocumentV1 | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string, options: Omit<TraceinkAssetRepositoryOptions, "filePath"> = {}) {
    if (!path.isAbsolute(filePath)) throw new Error("Traceink asset store path must be absolute.");
    this.io = options.io ?? nodeTraceinkAssetRepositoryIo;
    this.temporaryId = options.temporaryId ?? randomUUID;
    this.onPublish = options.onPublish;
  }

  load(): Promise<TraceinkAssetStoreDocumentV1> {
    return this.enqueue(async () => cloneDocument(await this.ensureLoaded()));
  }

  snapshot(): TraceinkAssetStoreDocumentV1 {
    if (!this.published) throw new Error("Traceink asset repository has not been loaded.");
    return cloneDocument(this.published);
  }

  mutate(
    operation: (current: TraceinkAssetStoreDocumentV1) => TraceinkAssetStoreDocumentV1
  ): Promise<TraceinkAssetStoreDocumentV1> {
    return this.enqueue(async () => {
      const current = await this.ensureLoaded();
      const proposed = operation(cloneDocument(current));
      const next = strictNormalizeDocument(proposed);
      await this.persistAtomically(next);
      this.publish(next);
      return cloneDocument(next);
    });
  }

  private async ensureLoaded(): Promise<TraceinkAssetStoreDocumentV1> {
    if (this.published) return this.published;
    try {
      const serialized = await this.io.readText(this.filePath);
      const document = parseTraceinkAssetStore(serialized);
      this.publish(document);
      return document;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      const empty = createEmptyTraceinkAssetStore();
      await this.persistAtomically(empty);
      this.publish(empty);
      return empty;
    }
  }

  private async persistAtomically(document: TraceinkAssetStoreDocumentV1): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporary = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${this.temporaryId()}.tmp`
    );
    await this.io.ensureDirectory(directory);
    try {
      await this.io.writeNewText(temporary, `${JSON.stringify(document, null, 2)}\n`);
      await this.io.replaceFile(temporary, this.filePath);
    } catch (error) {
      await this.io.removeFile(temporary).catch(() => undefined);
      throw error;
    }
  }

  private publish(document: TraceinkAssetStoreDocumentV1): void {
    const published = cloneDocument(document);
    this.published = published;
    try {
      this.onPublish?.(cloneDocument(published));
    } catch {
      // A presentation listener cannot roll back a completed durable write.
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

export function createTraceinkAssetRepository(options: TraceinkAssetRepositoryOptions): TraceinkAssetRepository {
  return new TraceinkAssetRepository(options.filePath, options);
}

export function traceinkAssetStorePath(userDataPath: string): string {
  if (!path.isAbsolute(userDataPath)) throw new Error("Traceink user data path must be absolute.");
  return path.join(userDataPath, TRACEINK_ASSET_STORE_FILE_NAME);
}

export function parseTraceinkAssetStore(serialized: string): TraceinkAssetStoreDocumentV1 {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("Traceink asset store is not valid JSON.");
  }
  return strictNormalizeDocument(value);
}

function strictNormalizeDocument(value: unknown): TraceinkAssetStoreDocumentV1 {
  const raw = asRecord(value);
  if (
    raw?.schemaVersion !== 1 ||
    !Array.isArray(raw.artifacts) ||
    !Array.isArray(raw.reflections) ||
    (raw.proposalDispositions !== undefined && !Array.isArray(raw.proposalDispositions)) ||
    !isRecord(raw.activeIndexByDate) ||
    (raw.structuredIndexes !== undefined && !Array.isArray(raw.structuredIndexes)) ||
    (raw.structuredIndexV2Candidates !== undefined && !Array.isArray(raw.structuredIndexV2Candidates)) ||
    (raw.structuredDossierV2Candidates !== undefined && !Array.isArray(raw.structuredDossierV2Candidates)) ||
    (raw.structuredDossiers !== undefined && !Array.isArray(raw.structuredDossiers)) ||
    (raw.activeStructuredIndexByDate !== undefined && !isRecord(raw.activeStructuredIndexByDate)) ||
    (raw.structuredReflections !== undefined && !Array.isArray(raw.structuredReflections)) ||
    (raw.structuredProposals !== undefined && !Array.isArray(raw.structuredProposals)) ||
    (raw.structuredProposalDispositions !== undefined && !Array.isArray(raw.structuredProposalDispositions)) ||
    (raw.structuredRuns !== undefined && !Array.isArray(raw.structuredRuns))
  ) {
    throw new Error("Traceink asset store envelope is invalid.");
  }
  const normalized = normalizeTraceinkAssetStore(value);
  if (
    normalized.artifacts.length !== raw.artifacts.length ||
    normalized.reflections.length !== raw.reflections.length ||
    (Array.isArray(raw.proposalDispositions) &&
      (normalized.proposalDispositions?.length ?? 0) !== raw.proposalDispositions.length) ||
    Object.keys(normalized.activeIndexByDate).length !== Object.keys(raw.activeIndexByDate).length ||
    (Array.isArray(raw.structuredIndexes) &&
      (normalized.structuredIndexes?.length ?? 0) !== raw.structuredIndexes.length) ||
    (Array.isArray(raw.structuredIndexV2Candidates) &&
      (normalized.structuredIndexV2Candidates?.length ?? 0) !== raw.structuredIndexV2Candidates.length) ||
    (Array.isArray(raw.structuredDossierV2Candidates) &&
      (normalized.structuredDossierV2Candidates?.length ?? 0) !== raw.structuredDossierV2Candidates.length) ||
    (Array.isArray(raw.structuredDossiers) &&
      (normalized.structuredDossiers?.length ?? 0) !== raw.structuredDossiers.length) ||
    (isRecord(raw.activeStructuredIndexByDate) &&
      Object.keys(normalized.activeStructuredIndexByDate ?? {}).length !== Object.keys(raw.activeStructuredIndexByDate).length) ||
    (Array.isArray(raw.structuredReflections) &&
      (normalized.structuredReflections?.length ?? 0) !== raw.structuredReflections.length) ||
    (Array.isArray(raw.structuredProposals) &&
      (normalized.structuredProposals?.length ?? 0) !== raw.structuredProposals.length) ||
    (Array.isArray(raw.structuredProposalDispositions) &&
      (normalized.structuredProposalDispositions?.length ?? 0) !== raw.structuredProposalDispositions.length) ||
    (Array.isArray(raw.structuredRuns) &&
      (normalized.structuredRuns?.length ?? 0) !== raw.structuredRuns.length)
  ) {
    throw new Error("Traceink asset store failed integrity validation.");
  }
  return normalized;
}

function cloneDocument(document: TraceinkAssetStoreDocumentV1): TraceinkAssetStoreDocumentV1 {
  return structuredClone(document);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

const nodeTraceinkAssetRepositoryIo: TraceinkAssetRepositoryIo = {
  readText(filePath) {
    return fs.readFile(filePath, "utf8");
  },
  async ensureDirectory(directoryPath) {
    await fs.mkdir(directoryPath, { recursive: true });
  },
  async writeNewText(filePath, text) {
    await fs.writeFile(filePath, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  },
  async replaceFile(sourcePath, destinationPath) {
    await fs.rename(sourcePath, destinationPath);
  },
  async removeFile(filePath) {
    await fs.rm(filePath, { force: true });
  }
};
