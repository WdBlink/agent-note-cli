import {
  DossierAnalysisCandidateSchema,
  DossierCandidateSchema,
  DossierCritiqueCandidateSchema,
  EditorialContractBindingSchema,
  SessionDigestCandidateSchema,
  StructuredTodayProposalSetCandidateSchema,
  WorklineSynthesisCandidateSchema,
  type DossierAnalysisCandidate,
  type DossierCandidate,
  type DossierCritiqueCandidate,
  type EditorialContractBindingV1,
  type SessionDigestCandidate,
  type StructuredTodayModelInvocationV1,
  type StructuredTodayProposalSetCandidate,
  type WorklineSynthesisCandidate
} from "./structured-today-contracts";
import { loadTraceinkSkillBundle } from "./traceink-skill-bundle";
import { z } from "zod";

export interface StructuredTodayModelResult<T> {
  output: T;
  invocation: StructuredTodayModelInvocationV1;
}

export interface StructuredTodayModelFunctions {
  digestSession(input: {
    logicalDate: string;
    editorialContract: EditorialContractBindingV1;
    sessionEvidenceJson: string;
    expectedSessionId: string;
    allowedEvidenceIds: [string, ...string[]];
  }): Promise<StructuredTodayModelResult<SessionDigestCandidate>>;
  synthesizeWorklineIndex(input: {
    logicalDate: string;
    editorialContract: EditorialContractBindingV1;
    evidenceManifestJson: string;
    sessionDigestsJson: string;
    allowedSessionIds: [string, ...string[]];
    allowedEvidenceIds: [string, ...string[]];
  }): Promise<StructuredTodayModelResult<WorklineSynthesisCandidate>>;
  analyzeWorklineDossier(input: {
    editorialContract: EditorialContractBindingV1;
    worklineJson: string;
    admittedEvidenceJson: string;
    allowedEvidenceIds: [string, ...string[]];
  }): Promise<StructuredTodayModelResult<DossierAnalysisCandidate>>;
  critiqueWorklineDossier(input: {
    editorialContract: EditorialContractBindingV1;
    analysisJson: string;
    admittedEvidenceJson: string;
  }): Promise<StructuredTodayModelResult<DossierCritiqueCandidate>>;
  composeWorklineDossier(input: {
    editorialContract: EditorialContractBindingV1;
    worklineJson: string;
    analysisJson: string;
    critiqueJson: string;
    admittedEvidenceJson: string;
    allowedEvidenceIds: [string, ...string[]];
  }): Promise<StructuredTodayModelResult<DossierCandidate>>;
  arrangeReflectionProposals(input: {
    editorialContract: EditorialContractBindingV1;
    dossierJson: string;
    reflectionText: string;
  }): Promise<StructuredTodayModelResult<StructuredTodayProposalSetCandidate>>;
}

export interface StructuredTodayCallResult {
  output: unknown;
  invocationId: string;
  provider: string;
  model: string;
}

/**
 * Provider adapter boundary for one strictly structured model invocation.
 * The desktop can implement this with its existing provider CLI or an
 * OpenAI-compatible local endpoint without leaking either response envelope
 * into the canonical Today artifact.
 */
export interface StructuredTodayStructuredCaller {
  call(input: {
    functionName: StructuredTodayModelInvocationV1["functionName"];
    functionVersion: string;
    instructions: string;
    variables: Record<string, string>;
    outputJsonSchema: Record<string, unknown>;
  }): Promise<StructuredTodayCallResult>;
}

export async function loadStructuredTodayEditorialContract(): Promise<EditorialContractBindingV1> {
  const bundle = await loadTraceinkSkillBundle();
  return EditorialContractBindingSchema.parse({
    ref: {
      packageId: bundle.packageId,
      version: bundle.version,
      editorialContractHash: bundle.editorialContractHash
    },
    text: bundle.editorialContractText
  });
}

export function createStructuredTodayModelFunctions(
  caller: StructuredTodayStructuredCaller
): StructuredTodayModelFunctions {
  return {
    digestSession: async (input) => invoke({
      caller,
      functionName: "DigestSession",
      functionVersion: "DigestSession/structured-v2",
      schema: SessionDigestCandidateSchema,
      editorialContract: input.editorialContract,
      instructions: "Digest exactly one provider-owned Session. Copy expectedSessionId exactly into sessionId; never add a provider prefix or rewrite it. Cite only IDs from allowedEvidenceIdsJson. Preserve uncertainty and current stop. Participation is an authority claim: describe human or joint participation only from messages whose authorKind is exactly human. A subagent task, planning message, tool event, automation message, or agent activity volume is agent activity and never proves human participation. If authority is unclear, leave human and joint empty and state an undeterminedReason. Do not group worklines here.",
      variables: {
        logicalDate: input.logicalDate,
        sessionEvidenceJson: input.sessionEvidenceJson,
        expectedSessionId: input.expectedSessionId,
        allowedEvidenceIdsJson: JSON.stringify(input.allowedEvidenceIds)
      },
      allowedSessionIds: [input.expectedSessionId],
      allowedEvidenceIds: input.allowedEvidenceIds
    }),
    synthesizeWorklineIndex: async (input) => {
      const instructions = "Reconstruct cross-Session worklines without producing dossiers. Account for every successful digest by exact assignment or explicit unresolved Session ID copied from allowedSessionIdsJson; never add provider prefixes or rewrite IDs. Workline sessionIds and assignments must describe exactly the same Session/workline pairs. Worklines may cite only IDs from allowedEvidenceIdsJson. Participation is an authority claim: human or joint participation may only be carried forward from an admitted Session digest that already has human or joint participation; never infer it from subagent work, planning, session count, or activity volume. If prose uses bracketed shorthand, [E1] means the first ID in that workline's evidenceIds array, [E2] the second, and so on; never use an unmapped shorthand.";
      const variables = {
        logicalDate: input.logicalDate,
        evidenceManifestJson: input.evidenceManifestJson,
        sessionDigestsJson: input.sessionDigestsJson,
        allowedSessionIdsJson: JSON.stringify(input.allowedSessionIds),
        allowedEvidenceIdsJson: JSON.stringify(input.allowedEvidenceIds)
      };
      const attempt = (repair?: { candidate: WorklineSynthesisCandidate; issues: string[] }) => invoke({
        caller,
        functionName: "SynthesizeWorklineIndex",
        functionVersion: "SynthesizeWorklineIndex/structured-v4",
        schema: WorklineSynthesisCandidateSchema,
        editorialContract: input.editorialContract,
        instructions: repair
          ? `${instructions} Your previous candidate failed deterministic relationship validation. Return a complete corrected replacement, not a patch or explanation. Use validationIssuesJson and rejectedCandidateJson only to correct the relationships.`
          : instructions,
        variables: {
          ...variables,
          ...(repair ? {
            validationIssuesJson: JSON.stringify(repair.issues),
            rejectedCandidateJson: JSON.stringify(repair.candidate)
          } : {})
        },
        allowedSessionIds: input.allowedSessionIds,
        allowedEvidenceIds: input.allowedEvidenceIds
      });
      const first = await attempt();
      const issues = structuredTodaySynthesisCoverageIssues(first.output, input.allowedSessionIds);
      if (issues.length === 0) return first;
      const repaired = await attempt({ candidate: first.output, issues });
      const repairIssues = structuredTodaySynthesisCoverageIssues(repaired.output, input.allowedSessionIds);
      if (repairIssues.length > 0) {
        throw new Error(`Structured Today synthesis relationship validation failed after one repair attempt: ${repairIssues.join(" ")}`);
      }
      return repaired;
    },
    analyzeWorklineDossier: async (input) => invoke({
      caller,
      functionName: "AnalyzeWorklineDossier",
      functionVersion: "AnalyzeWorklineDossier/structured-v4",
      schema: DossierAnalysisCandidateSchema,
      editorialContract: input.editorialContract,
      instructions: "Analyze only the selected workline and admitted evidence. Use host-supplied frozenContent for factual support; locators identify sources but are not source content. Do not read live source paths. Treat omitted or partial content as an evidence gap. Preserve supporting and opposing evidence, gaps, and a falsifiable future observation. Evidence claims may cite only exact IDs listed in allowedEvidenceIdsJson. If prose uses bracketed shorthand, [E1] means the first admitted evidence object, [E2] the second, and so on.",
      variables: {
        worklineJson: input.worklineJson,
        admittedEvidenceJson: input.admittedEvidenceJson,
        allowedEvidenceIdsJson: JSON.stringify(input.allowedEvidenceIds)
      },
      allowedEvidenceIds: input.allowedEvidenceIds
    }),
    critiqueWorklineDossier: async (input) => invoke({
      caller,
      functionName: "CritiqueWorklineDossier",
      functionVersion: "CritiqueWorklineDossier/structured-v2",
      schema: DossierCritiqueCandidateSchema,
      editorialContract: input.editorialContract,
      instructions: "Critique unsupported claims against host-supplied frozenContent, missing opposing evidence, invented evidence IDs, vague falsification, and hidden gaps. Do not read live source paths.",
      variables: {
        analysisJson: input.analysisJson,
        admittedEvidenceJson: input.admittedEvidenceJson
      }
    }),
    composeWorklineDossier: async (input) => invoke({
      caller,
      functionName: "ComposeWorklineDossier",
      functionVersion: "ComposeWorklineDossier/structured-v4",
      schema: DossierCandidateSchema,
      editorialContract: input.editorialContract,
      instructions: "Compose the final selected-workline dossier using host-supplied frozenContent, address the critique, retain uncertainty about omitted content, and end with exactly one question requiring the user's judgment. Every evidenceIds value must be copied from allowedEvidenceIdsJson. Critique missingEvidenceIds are requests for unavailable evidence and must never be cited as admitted evidence. If prose uses bracketed shorthand, [E1] means the first admitted evidence object, [E2] the second, and so on; never use an unmapped shorthand.",
      variables: {
        worklineJson: input.worklineJson,
        analysisJson: input.analysisJson,
        critiqueJson: input.critiqueJson,
        admittedEvidenceJson: input.admittedEvidenceJson,
        allowedEvidenceIdsJson: JSON.stringify(input.allowedEvidenceIds)
      },
      allowedEvidenceIds: input.allowedEvidenceIds
    }),
    arrangeReflectionProposals: async (input) => invoke({
      caller,
      functionName: "ArrangeReflectionProposals",
      functionVersion: "ArrangeReflectionProposals/structured-v1",
      schema: StructuredTodayProposalSetCandidateSchema,
      editorialContract: input.editorialContract,
      instructions: "Arrange the user's saved reflection into exactly the five proposal categories judgment, tomorrow, ctx, background, and today-only. Include at least one item in each category, preserve exact sourceQuote substrings, and never execute or adopt any proposal.",
      variables: {
        dossierJson: input.dossierJson,
        reflectionText: input.reflectionText
      }
    })
  };
}

export function structuredTodaySynthesisCoverageIssues(
  output: {
    worklines: Array<{ worklineId: string; sessionIds: string[] }>;
    assignments: Array<{ sessionId: string; worklineIds: string[] }>;
    unresolvedSessionIds: string[];
  },
  allowedSessionIds: readonly string[]
): string[] {
  const issues: string[] = [];
  const allowed = new Set(allowedSessionIds);
  const worklineById = new Map<string, (typeof output.worklines)[number]>();
  for (const workline of output.worklines) {
    if (worklineById.has(workline.worklineId)) {
      issues.push(`Synthesis produced duplicate workline ID ${workline.worklineId}.`);
    }
    worklineById.set(workline.worklineId, workline);
    if (new Set(workline.sessionIds).size !== workline.sessionIds.length) {
      issues.push(`Synthesis workline ${workline.worklineId} repeats a Session ID.`);
    }
  }

  const dispositionCounts = new Map<string, number>();
  for (const assignment of output.assignments) {
    if (!allowed.has(assignment.sessionId)) {
      issues.push(`Synthesis invented Session ${assignment.sessionId}.`);
    }
    dispositionCounts.set(assignment.sessionId, (dispositionCounts.get(assignment.sessionId) ?? 0) + 1);
    if (new Set(assignment.worklineIds).size !== assignment.worklineIds.length) {
      issues.push(`Synthesis assignment for Session ${assignment.sessionId} repeats a workline ID.`);
    }
    for (const worklineId of assignment.worklineIds) {
      const workline = worklineById.get(worklineId);
      if (!workline?.sessionIds.includes(assignment.sessionId)) {
        issues.push(`Synthesis assignment ${assignment.sessionId}/${worklineId} is not reciprocal.`);
      }
    }
  }
  for (const sessionId of output.unresolvedSessionIds) {
    if (!allowed.has(sessionId)) issues.push(`Synthesis invented unresolved Session ${sessionId}.`);
    dispositionCounts.set(sessionId, (dispositionCounts.get(sessionId) ?? 0) + 1);
  }
  if (new Set(output.unresolvedSessionIds).size !== output.unresolvedSessionIds.length) {
    issues.push("Synthesis repeats an unresolved Session ID.");
  }
  for (const workline of output.worklines) {
    for (const sessionId of workline.sessionIds) {
      if (!allowed.has(sessionId)) issues.push(`Synthesis workline invented Session ${sessionId}.`);
      const assignment = output.assignments.find((item) => item.sessionId === sessionId);
      if (!assignment?.worklineIds.includes(workline.worklineId)) {
        issues.push(`Synthesis workline ${workline.worklineId} lacks reciprocal assignment for Session ${sessionId}.`);
      }
    }
  }
  for (const sessionId of allowedSessionIds) {
    if (dispositionCounts.get(sessionId) !== 1) {
      issues.push(`Synthesis must cover Session ${sessionId} exactly once.`);
    }
  }
  return [...new Set(issues)];
}

async function invoke<T>(input: {
  caller: StructuredTodayStructuredCaller;
  functionName: StructuredTodayModelInvocationV1["functionName"];
  functionVersion: string;
  schema: z.ZodType<T>;
  editorialContract: EditorialContractBindingV1;
  instructions: string;
  variables: Record<string, string>;
  allowedEvidenceIds?: [string, ...string[]];
  allowedSessionIds?: [string, ...string[]];
}): Promise<StructuredTodayModelResult<T>> {
  const editorialContract = EditorialContractBindingSchema.parse(input.editorialContract);
  const outputJsonSchema = constrainEvidenceIds(
    constrainSessionIds(z.toJSONSchema(input.schema), input.allowedSessionIds),
    input.allowedEvidenceIds
  );
  const result = await input.caller.call({
    functionName: input.functionName,
    functionVersion: input.functionVersion,
    instructions: [
      input.instructions,
      "Apply the canonical Traceink editorial contract supplied in variables.editorialContract.",
      "Return only an object conforming to outputJsonSchema."
    ].join("\n"),
    variables: {
      editorialContract: editorialContract.text,
      editorialContractHash: editorialContract.ref.editorialContractHash,
      ...input.variables
    },
    outputJsonSchema
  });
  return {
    output: input.schema.parse(result.output),
    invocation: {
      invocationId: result.invocationId,
      provider: result.provider,
      model: result.model,
      functionName: input.functionName,
      functionVersion: input.functionVersion
    }
  };
}

function constrainSessionIds(
  schema: Record<string, unknown>,
  allowedSessionIds: [string, ...string[]] | undefined
): Record<string, unknown> {
  if (!allowedSessionIds) return schema;
  return constrainSessionIdsNode(schema, allowedSessionIds) as Record<string, unknown>;
}

function constrainSessionIdsNode(value: unknown, allowedSessionIds: [string, ...string[]]): unknown {
  if (Array.isArray(value)) return value.map((item) => constrainSessionIdsNode(item, allowedSessionIds));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const constrained = Object.fromEntries(Object.entries(record).map(([key, item]) => [
    key,
    constrainSessionIdsNode(item, allowedSessionIds)
  ]));
  if (constrained.type === "object" && constrained.properties && typeof constrained.properties === "object") {
    const properties = constrained.properties as Record<string, unknown>;
    if (properties.sessionId && typeof properties.sessionId === "object") {
      properties.sessionId = {
        ...(properties.sessionId as Record<string, unknown>),
        enum: [...allowedSessionIds]
      };
    }
    for (const key of ["sessionIds", "unresolvedSessionIds"]) {
      const sessionIds = properties[key];
      if (sessionIds && typeof sessionIds === "object") {
        properties[key] = {
          ...(sessionIds as Record<string, unknown>),
          items: { type: "string", enum: [...allowedSessionIds] }
        };
      }
    }
  }
  return constrained;
}

function constrainEvidenceIds(
  schema: Record<string, unknown>,
  allowedEvidenceIds: [string, ...string[]] | undefined
): Record<string, unknown> {
  if (!allowedEvidenceIds) return schema;
  return constrainEvidenceIdsNode(schema, allowedEvidenceIds) as Record<string, unknown>;
}

function constrainEvidenceIdsNode(value: unknown, allowedEvidenceIds: [string, ...string[]]): unknown {
  if (Array.isArray(value)) return value.map((item) => constrainEvidenceIdsNode(item, allowedEvidenceIds));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const constrained = Object.fromEntries(Object.entries(record).map(([key, item]) => [
    key,
    constrainEvidenceIdsNode(item, allowedEvidenceIds)
  ]));
  if (constrained.type === "object" && constrained.properties && typeof constrained.properties === "object") {
    const properties = constrained.properties as Record<string, unknown>;
    const evidenceIds = properties.evidenceIds;
    if (evidenceIds && typeof evidenceIds === "object") {
      properties.evidenceIds = {
        ...(evidenceIds as Record<string, unknown>),
        items: { type: "string", enum: [...allowedEvidenceIds] }
      };
    }
  }
  return constrained;
}
