// Same synthetic model responses as the App integration test. No provider calls.
export function structuredRunner() {
  return async (request) => {
    const evidenceId = "session:codex:session-1";
    let output;
    if (request.stdin.includes("Digest exactly one")) {
      output = {
        sessionId: "session-1",
        summary: "完成结构化 workflow 接缝。",
        currentStop: "等待接入 Today UI。",
        participation: { human: "用户确定方向。", agent: "Agent 完成实现。" },
        evidenceIds: [evidenceId],
        uncertainties: []
      };
    } else if (request.stdin.includes("Reconstruct cross-Session")) {
      output = {
        worklines: [{
          worklineId: "workline-structured-today",
          title: "结构化 Today 后端",
          summary: "把确定性控制流与模型节点分离。",
          startedAt: "2026-08-29T01:00:00.000Z",
          endedAt: "2026-08-29T01:10:00.000Z",
          currentStop: "等待 UI 切换。",
          possibleChange: "Today 可以稳定显示结构化工作线。",
          participation: { human: "确定产品方向。", agent: "完成工程实现。" },
          evidenceReadiness: "ready",
          sessionIds: ["session-1"],
          evidenceIds: [evidenceId],
          extensions: []
        }],
        assignments: [{ sessionId: "session-1", worklineIds: ["workline-structured-today"] }],
        unresolvedSessionIds: []
      };
    } else if (request.stdin.includes("Analyze only the selected")) {
      output = {
        priorContext: "旧路径依赖 Markdown 解析。",
        whatHappened: "结构化 index 已持久化。",
        possibleChange: "核心导航不再依赖 Markdown。",
        supportingEvidence: [{ claim: "Session 已进入结构化工作线。", evidenceIds: [evidenceId] }],
        opposingEvidence: [],
        falsifiableObservation: "刷新后 Session membership 必须保持一致。",
        gaps: []
      };
    } else if (request.stdin.includes("Critique unsupported")) {
      output = { acceptable: true, issues: [], missingEvidenceIds: [] };
    } else if (request.stdin.includes("Compose the final")) {
      output = {
        title: "结构化 Today 证据档案",
        priorContext: "旧路径依赖 Markdown 解析。",
        whatHappened: "结构化 index 已持久化。",
        possibleChange: "核心导航不再依赖 Markdown。",
        supportingEvidence: [{ claim: "Session 已进入结构化工作线。", evidenceIds: [evidenceId] }],
        opposingEvidence: [],
        falsifiableObservation: "刷新后 Session membership 必须保持一致。",
        gaps: [],
        humanQuestion: "是否把结构化 producer 设为默认路径？",
        evidenceIds: [evidenceId],
        extensions: []
      };
    } else if (request.stdin.includes("Arrange the user")) {
      const sourceQuote = "我确认结构化工作线能够重开，但仍需验证完整封页。";
      output = {
        proposals: ["judgment", "tomorrow", "ctx", "background", "today-only"].map((category) => ({
          category,
          proposalText: `${category} proposal`,
          sourceQuote,
          evidenceIds: category === "judgment" ? [evidenceId] : []
        }))
      };
    } else {
      throw new Error(`Unexpected structured prompt: ${request.stdin.slice(0, 80)}`);
    }
    return {
      stdout: `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(output) } })}\n`,
      stderr: ""
    };
  };
}

