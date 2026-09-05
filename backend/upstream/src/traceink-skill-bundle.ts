import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TRACEINK_SKILL_PACKAGE_ID = "traceink" as const;
export const TRACEINK_SKILL_BUNDLE_VERSION = "traceink-skill-bundle-v1" as const;
export const TRACEINK_SKILL_SHA256 = "0596391934a10552937ab4b16c3a22911a8915d50670f5075c2e52eb3db002ca" as const;
export const TRACEINK_EDITORIAL_CONTRACT_SHA256 = "9b39a78a37c62677b487cb29931c158fda4183a0e7b7efeb3b1eab231caa5279" as const;

export interface TraceinkSkillBundle {
  readonly packageId: typeof TRACEINK_SKILL_PACKAGE_ID;
  readonly version: typeof TRACEINK_SKILL_BUNDLE_VERSION;
  readonly skillText: string;
  readonly editorialContractText: string;
  readonly skillHash: string;
  readonly editorialContractHash: string;
}

export type TraceinkSkillBundleErrorCode = "bundle_missing" | "bundle_unreadable" | "bundle_integrity_mismatch";

export class TraceinkSkillBundleError extends Error {
  constructor(
    readonly code: TraceinkSkillBundleErrorCode,
    message: string
  ) {
    super(message);
    this.name = "TraceinkSkillBundleError";
  }
}

/**
 * Loads only the Traceink package owned by this application. In source it is
 * resolved from the repository's skills directory; after bundling it must sit
 * beside the desktop entry module. There is intentionally no home-directory,
 * CODEX_HOME, current-working-directory, or user-installed Skill fallback.
 */
export async function loadTraceinkSkillBundle(
  runtimeModuleUrl: string | URL = import.meta.url
): Promise<TraceinkSkillBundle> {
  const bundleRoot = resolveBundleRoot(runtimeModuleUrl);
  const skillPath = path.join(bundleRoot, "SKILL.md");
  const editorialContractPath = path.join(bundleRoot, "references", "editorial-contract.md");
  const [skillBytes, editorialContractBytes] = await Promise.all([
    readBundleFile(skillPath),
    readBundleFile(editorialContractPath)
  ]);
  const skillHash = sha256(skillBytes);
  const editorialContractHash = sha256(editorialContractBytes);

  assertHash(skillPath, skillHash, TRACEINK_SKILL_SHA256);
  assertHash(editorialContractPath, editorialContractHash, TRACEINK_EDITORIAL_CONTRACT_SHA256);

  return Object.freeze({
    packageId: TRACEINK_SKILL_PACKAGE_ID,
    version: TRACEINK_SKILL_BUNDLE_VERSION,
    skillText: skillBytes.toString("utf8"),
    editorialContractText: editorialContractBytes.toString("utf8"),
    skillHash,
    editorialContractHash
  });
}

function resolveBundleRoot(runtimeModuleUrl: string | URL): string {
  const moduleDirectory = path.dirname(fileURLToPath(runtimeModuleUrl));
  if (path.basename(moduleDirectory) === "src") {
    return path.resolve(moduleDirectory, "..", "skills", TRACEINK_SKILL_PACKAGE_ID);
  }
  return path.join(moduleDirectory, "skills", TRACEINK_SKILL_PACKAGE_ID);
}

async function readBundleFile(filePath: string): Promise<Buffer> {
  try {
    return await readFile(filePath);
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new TraceinkSkillBundleError("bundle_missing", `Bundled Traceink file is missing: ${filePath}`);
    }
    throw new TraceinkSkillBundleError("bundle_unreadable", `Bundled Traceink file could not be read: ${filePath}`);
  }
}

function assertHash(filePath: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new TraceinkSkillBundleError(
      "bundle_integrity_mismatch",
      `Bundled Traceink file failed its integrity check: ${filePath}`
    );
  }
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function nodeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
