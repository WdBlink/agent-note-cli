import type { AgentPlatform } from "./types";

export function familyChildEvidenceId(session: { platform: AgentPlatform; id: string }): string {
  return `family-child:${session.platform}:${encodeURIComponent(session.id)}`;
}
