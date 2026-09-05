import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createTraceinkAssetRepository,
  parseTraceinkAssetStore,
  TRACEINK_ASSET_STORE_FILE_NAME,
  type TraceinkAssetRepositoryIo
} from "../app/desktop/traceink-asset-repository";
import {
  appendTraceinkIndexRevision,
  createEmptyTraceinkAssetStore
} from "../app/desktop/traceink-asset-store";
import type { TraceinkIndexArtifactDraftV1 } from "../src/traceink-review-assets";

test("repository creates a standalone store and reloads exact rawMarkdown bytes after atomic replacement", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "traceink-repository-"));
  const filePath = path.join(directory, TRACEINK_ASSET_STORE_FILE_NAME);
  const writes: string[] = [];
  const replacements: Array<[string, string]> = [];
  const published: string[] = [];
  const io = recordingIo(writes, replacements);
  const rawMarkdown = "\n# 工作线\r\n\r\n  保留空格  \r\n";
  try {
    const repository = createTraceinkAssetRepository({
      filePath,
      io,
      temporaryId: () => "fixed",
      onPublish(document) {
        published.push(document.artifacts.at(-1)?.rawMarkdown ?? "empty");
      }
    });
    assert.deepEqual(await repository.load(), createEmptyTraceinkAssetStore());
    const saved = await repository.mutate((current) => appendTraceinkIndexRevision(
      current,
      indexDraft(rawMarkdown)
    ));

    assert.equal(saved.artifacts.length, 1);
    assert.equal(saved.artifacts[0]?.rawMarkdown, rawMarkdown);
    assert.deepEqual(published, ["empty", rawMarkdown]);
    assert.equal(writes.length, 2);
    assert.equal(replacements.length, 2);
    for (const [temporary, destination] of replacements) {
      assert.equal(path.dirname(temporary), directory);
      assert.equal(destination, filePath);
      assert.notEqual(temporary, destination);
    }

    const reloaded = createTraceinkAssetRepository({ filePath });
    const diskDocument = await reloaded.load();
    assert.equal(diskDocument.artifacts[0]?.rawMarkdown, rawMarkdown);
    assert.deepEqual(diskDocument, saved);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("failed persistence does not publish a candidate and the serialized queue remains usable", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "traceink-repository-failure-"));
  const filePath = path.join(directory, TRACEINK_ASSET_STORE_FILE_NAME);
  let failReplacement = false;
  const publications: number[] = [];
  const io = recordingIo([], [], () => failReplacement);
  try {
    const repository = createTraceinkAssetRepository({
      filePath,
      io,
      onPublish(document) { publications.push(document.artifacts.length); }
    });
    await repository.load();
    failReplacement = true;

    await assert.rejects(repository.mutate((current) => appendTraceinkIndexRevision(
      current,
      indexDraft("# must not publish\n")
    )), /simulated durable replacement failure/);

    assert.equal(repository.snapshot().artifacts.length, 0);
    assert.deepEqual(publications, [0]);
    assert.deepEqual(parseTraceinkAssetStore(await fs.readFile(filePath, "utf8")), createEmptyTraceinkAssetStore());
    assert.deepEqual((await fs.readdir(directory)).sort(), [TRACEINK_ASSET_STORE_FILE_NAME]);

    failReplacement = false;
    const recovered = await repository.mutate((current) => appendTraceinkIndexRevision(
      current,
      indexDraft("# later success\n")
    ));
    assert.equal(recovered.artifacts.length, 1);
    assert.deepEqual(publications, [0, 1]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("repository rejects malformed existing storage instead of replacing it with an empty store", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "traceink-repository-malformed-"));
  const filePath = path.join(directory, TRACEINK_ASSET_STORE_FILE_NAME);
  const original = "{\"schemaVersion\":1,\"artifacts\":\"not-an-array\"}\n";
  try {
    await fs.writeFile(filePath, original, "utf8");
    const repository = createTraceinkAssetRepository({ filePath });
    await assert.rejects(repository.load(), /envelope is invalid/);
    assert.equal(await fs.readFile(filePath, "utf8"), original);
    assert.throws(() => repository.snapshot(), /has not been loaded/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function recordingIo(
  writes: string[],
  replacements: Array<[string, string]>,
  shouldFailReplacement: () => boolean = () => false
): TraceinkAssetRepositoryIo {
  return {
    readText(filePath) { return fs.readFile(filePath, "utf8"); },
    async ensureDirectory(directoryPath) { await fs.mkdir(directoryPath, { recursive: true }); },
    async writeNewText(filePath, text) {
      writes.push(filePath);
      await fs.writeFile(filePath, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    },
    async replaceFile(sourcePath, destinationPath) {
      replacements.push([sourcePath, destinationPath]);
      if (shouldFailReplacement()) throw new Error("simulated durable replacement failure");
      await fs.rename(sourcePath, destinationPath);
    },
    async removeFile(filePath) { await fs.rm(filePath, { force: true }); }
  };
}

function indexDraft(rawMarkdown: string): TraceinkIndexArtifactDraftV1 {
  return {
    schemaVersion: 1,
    logicalDate: "2026-08-15",
    stage: "index",
    producer: {
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningConfiguration: "ultra",
      startedAt: "2026-08-15T10:00:00.000Z",
      completedAt: "2026-08-15T10:05:00.000Z",
      skill: {
        packageId: "traceink",
        version: "traceink-skill-bundle-v1",
        skillHash: "a".repeat(64),
        editorialContractHash: "b".repeat(64)
      }
    },
    inputEvidenceHash: "c".repeat(64),
    rawMarkdown,
    coverage: [],
    evidence: [],
    navigation: [],
    warnings: []
  };
}
