export type SessionUserAuthorKind = "human" | "agent" | "automation" | "unknown";

/**
 * Protocol role is not authorship. Only a provider record classified as a
 * primary host interaction may contribute a human intervention.
 */
export function sessionUserAuthorKind(session: { lineage?: { origin: string } | undefined }): SessionUserAuthorKind {
  if (session.lineage?.origin === "subagent") return "agent";
  if (session.lineage?.origin === "automation") return "automation";
  if (session.lineage?.origin === "primary") return "human";
  return "unknown";
}
