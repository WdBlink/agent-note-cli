import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  structuredTodayProviderSchema,
  freezeStructuredTodayProviderPlan,
  createStructuredTodayCliCaller,
  pinSingleValueEnums
} from "../app/desktop/structured-today-cli-caller";
import { DEFAULT_SETTINGS } from "../src/constants";
import {
  SessionDigestCandidateSchema,
  sha256Text
} from "../src/structured-today-contracts";
import { createStructuredTodayModelFunctions } from "../src/structured-today-model-functions";
import { parseCursorOutput } from "../src/agent-summary";

test("provider schemas remove the unsupported draft declaration", () => {
  const canonical = z.toJSONSchema(SessionDigestCandidateSchema);
  assert.equal(canonical.$schema, "https://json-schema.org/draft/2020-12/schema");

  const claude = structuredTodayProviderSchema(canonical, "claude");
  assert.equal(claude.$schema, undefined);
  assert.deepEqual(claude.properties, canonical.properties);
});

test("Cursor-only sources digest and synthesize with Cursor Agent CLI", () => {
  const plan = freezeStructuredTodayProviderPlan(
    { ...DEFAULT_SETTINGS, enabledSessionProviders: ["cursor"] },
    [{ sessionId: "cursor-session", provider: "cursor" }]
  );
  assert.equal(plan.digestBySessionId["cursor-session"], "cursor");
  assert.equal(plan.functionProviders.SynthesizeWorklineIndex, "cursor");
  assert.equal(plan.functionProviders.CritiqueWorklineDossier, "cursor");
  assert.equal(plan.models.cursor, "default");
});

test("mixed sources keep Codex as primary, Claude as critic, and digest Cursor sessions with Cursor", () => {
  const plan = freezeStructuredTodayProviderPlan(
    DEFAULT_SETTINGS,
    [
      { sessionId: "codex-session", provider: "codex" },
      { sessionId: "claude-session", provider: "claude" },
      { sessionId: "cursor-session", provider: "cursor" }
    ]
  );
  assert.equal(plan.digestBySessionId["codex-session"], "codex");
  assert.equal(plan.digestBySessionId["claude-session"], "claude");
  assert.equal(plan.digestBySessionId["cursor-session"], "cursor");
  assert.equal(plan.functionProviders.SynthesizeWorklineIndex, "codex");
  assert.equal(plan.functionProviders.CritiqueWorklineDossier, "claude");
});

test("Cursor compiler calls agent CLI and parses a Claude-shaped JSON envelope", async () => {
  const plan = freezeStructuredTodayProviderPlan(
    { ...DEFAULT_SETTINGS, enabledSessionProviders: ["cursor"] },
    [{ sessionId: "cursor-session", provider: "cursor" }]
  );
  let request: { command: string; args: string[]; stdin: string; cwd: string; stdoutMode?: string } | undefined;
  const caller = createStructuredTodayCliCaller({
    settings: { ...DEFAULT_SETTINGS, enabledSessionProviders: ["cursor"], cursorCliPath: "agent" },
    plan,
    timeoutMs: 1_000,
    async runner(input) {
      request = input;
      const output = {
        sessionId: "cursor-session",
        summary: "summary",
        currentStop: "stop",
        participation: { human: "human", agent: null, joint: null, undeterminedReason: null },
        evidenceIds: ["evidence-1"],
        uncertainties: []
      };
      return {
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: JSON.stringify(output)
        }),
        stderr: ""
      };
    }
  });
  const result = await caller.call({
    functionName: "DigestSession",
    functionVersion: "DigestSession/structured-v1",
    instructions: "Digest exactly one session.",
    variables: { expectedSessionId: "cursor-session" },
    outputJsonSchema: { type: "object", properties: { sessionId: { type: "string" } } }
  });
  assert.ok(request);
  assert.equal(request.command, "agent");
  assert.deepEqual(request.args.slice(0, 8), [
    "--print",
    "--output-format",
    "json",
    "--mode",
    "ask",
    "--trust",
    "--sandbox",
    "enabled"
  ]);
  assert.equal(request.stdoutMode, "single-json");
  // Cursor has no structured-output flag, so the schema must reach it inline.
  assert.match(request.stdin, /"properties":\{"sessionId":\{"type":"string"\}\}/);
  assert.doesNotMatch(request.stdin, /output\.schema\.json/);
  assert.doesNotMatch(request.stdin, new RegExp(request.cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(result.provider, "cursor");
  assert.equal(result.model, "default");
  assert.ok(!request.args.includes("--model"), "the account default model is left to the CLI");
  assert.equal((result.output as { sessionId?: string }).sessionId, "cursor-session");
});

// Observed against Cursor Agent CLI 2026.09.02: a complete synthesis object arrived
// with a stray closing brace appended on the next line.
test("a Cursor reply framed with stray text still yields the first complete value", () => {
  const value = { worklines: [{ worklineId: "w-1", sessionIds: ["s-1"] }], unresolvedSessionIds: [] };
  const envelope = (result: string) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result });

  assert.deepEqual(parseCursorOutput(envelope(JSON.stringify(value))), value);
  assert.deepEqual(parseCursorOutput(envelope(`${JSON.stringify(value)}\n}`)), value);
  assert.deepEqual(parseCursorOutput(envelope("```json\n" + JSON.stringify(value) + "\n```")), value);
  assert.deepEqual(parseCursorOutput(envelope(`这是结果：\n${JSON.stringify(value)}\n以上。`)), value);
  assert.throws(() => parseCursorOutput(envelope("no JSON at all")), /Cursor|JSON/);
});

// Observed against Cursor Agent CLI 2026.09.02: it retyped a pinned Session ID as
// "<prefix>-<prefix>-<id>" because no CLI flag enforces the schema.
test("a Cursor response that retypes a pinned identifier is restored, not invented", () => {
  const schema = {
    type: "object",
    properties: {
      sessionId: { enum: ["2c0aa10b-d54b-461b-b06c-2a09f67d3192"] },
      summary: { type: "string" },
      evidenceIds: { type: "array", items: { enum: ["evidence-1", "evidence-2"] } },
      participation: { type: "object", properties: { human: { type: "string" } } }
    }
  };
  const pinned = pinSingleValueEnums({
    sessionId: "2c0aa10b-d54b-461b-b06c-2c0aa10b-d54b-461b-b06c-2a09f67d3192",
    summary: "model prose stays untouched",
    evidenceIds: ["evidence-2"],
    participation: { human: "human prose stays untouched" }
  }, schema) as Record<string, unknown>;

  assert.equal(pinned.sessionId, "2c0aa10b-d54b-461b-b06c-2a09f67d3192");
  assert.equal(pinned.summary, "model prose stays untouched");
  assert.deepEqual(pinned.evidenceIds, ["evidence-2"], "an enum with real choices is never rewritten");
  assert.deepEqual(pinned.participation, { human: "human prose stays untouched" });
});

test("Codex provider schema requires every declared property recursively", () => {
  const canonical = z.toJSONSchema(SessionDigestCandidateSchema);
  const codex = structuredTodayProviderSchema(canonical, "codex");
  const properties = record(codex.properties);
  const participation = record(record(properties.participation).properties);
  const participationSchema = record(properties.participation);

  assert.equal(codex.$schema, undefined);
  assert.equal(codex.additionalProperties, false);
  assert.deepEqual(codex.required, Object.keys(properties));
  assert.equal(participationSchema.additionalProperties, false);
  assert.deepEqual(participationSchema.required, Object.keys(participation));
  for (const field of ["human", "agent", "joint", "undeterminedReason"]) {
    assert.match(JSON.stringify(participation[field]), /null/);
  }
});

test("dossier compose schema admits only exact gathered evidence IDs", async () => {
  let call: {
    variables: Record<string, string>;
    outputJsonSchema: Record<string, unknown>;
  } | undefined;
  const models = createStructuredTodayModelFunctions({
    async call(input) {
      call = input;
      return {
        output: {
          priorContext: "prior",
          whatHappened: "happened",
          possibleChange: "possible",
          supportingEvidence: [{ claim: "claim", evidenceIds: ["evidence-1"] }],
          opposingEvidence: [],
          falsifiableObservation: "observation",
          gaps: [],
          title: "title",
          humanQuestion: "question?",
          evidenceIds: ["evidence-1"],
          extensions: []
        },
        invocationId: "invocation-1",
        provider: "codex",
        model: "model-1"
      };
    }
  });
  const editorialText = "canonical editorial contract";
  await models.composeWorklineDossier({
    editorialContract: {
      ref: {
        packageId: "traceink",
        version: "test",
        editorialContractHash: sha256Text(editorialText)
      },
      text: editorialText
    },
    worklineJson: "{}",
    analysisJson: "{}",
    admittedEvidenceJson: "[]",
    critiqueJson: JSON.stringify({ missingEvidenceIds: ["critique-json"] }),
    allowedEvidenceIds: ["evidence-1"]
  });

  assert.ok(call);
  assert.equal(call.variables.allowedEvidenceIdsJson, '["evidence-1"]');
  const serialized = JSON.stringify(call.outputJsonSchema);
  assert.match(serialized, /"enum":\["evidence-1"\]/);
  assert.doesNotMatch(serialized, /critique-json/);
});

test("digest schema admits only the exact provider-owned Session ID", async () => {
  let outputSchema: Record<string, unknown> | undefined;
  const models = createStructuredTodayModelFunctions({
    async call(input) {
      outputSchema = input.outputJsonSchema;
      return {
        output: {
          sessionId: "session-1",
          summary: "summary",
          currentStop: "stop",
          participation: { human: "human", agent: null, joint: null, undeterminedReason: null },
          evidenceIds: ["evidence-1"],
          uncertainties: []
        },
        invocationId: "invocation-1",
        provider: "claude",
        model: "model-1"
      };
    }
  });
  const editorialText = "canonical editorial contract";
  await models.digestSession({
    logicalDate: "2026-08-29",
    editorialContract: {
      ref: {
        packageId: "traceink",
        version: "test",
        editorialContractHash: sha256Text(editorialText)
      },
      text: editorialText
    },
    sessionEvidenceJson: "{}",
    expectedSessionId: "session-1",
    allowedEvidenceIds: ["evidence-1"]
  });

  assert.ok(outputSchema);
  const sessionId = record(record(outputSchema.properties).sessionId);
  assert.deepEqual(sessionId.enum, ["session-1"]);
  assert.doesNotMatch(JSON.stringify(outputSchema), /session:claude:session-1/);
});

test("workline synthesis repairs an invalid Session relationship once", async () => {
  const calls: Array<Parameters<Parameters<typeof createStructuredTodayModelFunctions>[0]["call"]>[0]> = [];
  const models = createStructuredTodayModelFunctions({
    async call(input) {
      calls.push(input);
      return {
        output: synthesisCandidate(calls.length === 1 ? [] : [{ sessionId: "session-1", worklineIds: ["workline-1"] }]),
        invocationId: `invocation-${calls.length}`,
        provider: "codex",
        model: "model-1"
      };
    }
  });

  const result = await models.synthesizeWorklineIndex({
    logicalDate: "2026-08-30",
    editorialContract: editorialContract(),
    evidenceManifestJson: "{}",
    sessionDigestsJson: "[]",
    allowedSessionIds: ["session-1"],
    allowedEvidenceIds: ["evidence-1"]
  });

  assert.equal(calls.length, 2);
  assert.equal(result.invocation.functionVersion, "SynthesizeWorklineIndex/structured-v4");
  assert.match(calls[1]!.instructions, /complete corrected replacement/u);
  assert.match(calls[1]!.variables.validationIssuesJson ?? "", /lacks reciprocal assignment/u);
  assert.ok(calls[1]!.variables.rejectedCandidateJson);
});

test("workline synthesis stops after one failed relationship repair", async () => {
  let calls = 0;
  const models = createStructuredTodayModelFunctions({
    async call() {
      calls += 1;
      return {
        output: synthesisCandidate([]),
        invocationId: `invocation-${calls}`,
        provider: "codex",
        model: "model-1"
      };
    }
  });

  await assert.rejects(() => models.synthesizeWorklineIndex({
    logicalDate: "2026-08-30",
    editorialContract: editorialContract(),
    evidenceManifestJson: "{}",
    sessionDigestsJson: "[]",
    allowedSessionIds: ["session-1"],
    allowedEvidenceIds: ["evidence-1"]
  }), /failed after one repair attempt/u);
  assert.equal(calls, 2);
});

function synthesisCandidate(assignments: Array<{ sessionId: string; worklineIds: string[] }>) {
  return {
    worklines: [{
      worklineId: "workline-1",
      title: "Workline",
      summary: "Summary",
      startedAt: "2026-08-30T01:00:00.000Z",
      endedAt: "2026-08-30T02:00:00.000Z",
      currentStop: "Stop",
      possibleChange: "Change",
      participation: { agent: "Agent work" },
      evidenceReadiness: "ready",
      sessionIds: ["session-1"],
      evidenceIds: ["evidence-1"],
      extensions: []
    }],
    assignments,
    unresolvedSessionIds: []
  };
}

function editorialContract() {
  const text = "canonical editorial contract";
  return {
    ref: {
      packageId: "traceink" as const,
      version: "test",
      editorialContractHash: sha256Text(text)
    },
    text
  };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
