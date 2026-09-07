import type { AgentPlatform } from "./types";
import type { EvidenceLocatorV1 } from "./structured-today-contracts";

export function familyChildEvidenceId(session: { platform: AgentPlatform; id: string }): string {
  return `family-child:${session.platform}:${encodeURIComponent(session.id)}`;
}

/** Resolve historical family-child locators through the same tuple as primary transcripts. */
export function structuredTranscriptEvidence(evidence: EvidenceLocatorV1 | undefined) {
  if (!evidence?.provider) return undefined;
  if (evidence.sourceKind === "session") {
    return evidence.sessionId ? { ...evidence, provider: evidence.provider, sessionId: evidence.sessionId } : undefined;
  }
  const prefix = `family-child:${evidence.provider}:`;
  if (!evidence.evidenceId.startsWith(prefix)) return undefined;
  try {
    const sessionId = decodeURIComponent(evidence.evidenceId.slice(prefix.length));
    if (!sessionId || familyChildEvidenceId({ platform: evidence.provider, id: sessionId }) !== evidence.evidenceId) return undefined;
    if (evidence.sessionId && evidence.sessionId !== sessionId) return undefined;
    return { ...evidence, provider: evidence.provider, sessionId };
  } catch {
    return undefined;
  }
}
