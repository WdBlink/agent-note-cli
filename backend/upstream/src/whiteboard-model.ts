export type WhiteboardProvider = "codex" | "claude-code";
export type WhiteboardRuntimeState = "starting" | "running" | "waiting" | "exited" | "failed";
export type WhiteboardNodeKind = "agent" | "terminal" | "note" | "label";

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasSize {
  width: number;
  height: number;
}

export interface ProjectFrame {
  id: string;
  name: string;
  rootPath: string;
  position: CanvasPoint;
  size: CanvasSize;
  zIndex: number;
}

interface WhiteboardNodeBase {
  id: string;
  kind: WhiteboardNodeKind;
  projectId: string | null;
  position: CanvasPoint;
  size: CanvasSize;
  zIndex: number;
}

export interface WhiteboardAgentNode extends WhiteboardNodeBase {
  kind: "agent";
  projectId: string;
  provider: WhiteboardProvider;
  workingDirectory: string;
  sessionId: string | null;
  sessionIdVerified: boolean;
  runtimeState: WhiteboardRuntimeState;
}

export interface WhiteboardTerminalNode extends WhiteboardNodeBase {
  kind: "terminal";
  projectId: string;
  workingDirectory: string;
  runtimeId: string | null;
}

export interface WhiteboardNoteNode extends WhiteboardNodeBase {
  kind: "note";
  projectId: string;
  markdown: string;
}

export interface WhiteboardLabelNode extends WhiteboardNodeBase {
  kind: "label";
  projectId: string | null;
  text: string;
  color: string;
  fontSize: 56;
}

export type WhiteboardNode = WhiteboardAgentNode | WhiteboardTerminalNode | WhiteboardNoteNode | WhiteboardLabelNode;

export interface WhiteboardEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
}

export interface GlobalBoardDocument {
  schemaVersion: 2;
  viewport: { x: number; y: number; zoom: number };
  projects: ProjectFrame[];
  nodes: WhiteboardNode[];
  edges: WhiteboardEdge[];
  console: { provider: WhiteboardProvider };
}

export type WhiteboardCommitResult =
  | { ok: true; document: GlobalBoardDocument; revision: number }
  | { ok: false; code: "WHITEBOARD_REVISION_CONFLICT"; document: GlobalBoardDocument; revision: number };

// Retained as a source-compatible name for CockpitData while the persisted value is schema two.
export type WhiteboardStore = GlobalBoardDocument;
export type WhiteboardDocument = GlobalBoardDocument;
export type WhiteboardProject = ProjectFrame;

export class WhiteboardMigrationError extends Error {
  readonly code = "WHITEBOARD_MIGRATION_FAILED" as const;

  constructor(message: string) {
    super(message);
    this.name = "WhiteboardMigrationError";
  }
}

export class WhiteboardRebaseError extends Error {
  readonly code = "WHITEBOARD_REBASE_CONFLICT" as const;

  constructor(message: string, readonly conflicts: readonly string[] = [message]) {
    super(message);
    this.name = "WhiteboardRebaseError";
  }
}

export const EMPTY_WHITEBOARD_VIEWPORT = { x: 80, y: 72, zoom: 1 } as const;
export const DEFAULT_FRAME_SIZE = { width: 1320, height: 900 } as const;
export const FRAME_INSET = { left: 48, top: 104, right: 48, bottom: 48 } as const;
export const FRAME_RESIZE_CLEARANCE = { left: 24, top: 84, right: 24, bottom: 24 } as const;

const NODE_DEFAULTS: Record<WhiteboardNodeKind, CanvasSize> = {
  agent: { width: 520, height: 340 },
  terminal: { width: 520, height: 320 },
  note: { width: 320, height: 240 },
  label: { width: 560, height: 112 }
};

const NODE_MINIMUMS: Record<WhiteboardNodeKind, CanvasSize> = {
  agent: { width: 360, height: 240 },
  terminal: { width: 360, height: 220 },
  note: { width: 240, height: 160 },
  label: { width: 240, height: 88 }
};

const LABEL_COLORS = new Set(["#202825", "#2f6f5e", "#315f82", "#b13a32", "#9a6a17"]);

export function createEmptyGlobalBoardDocument(): GlobalBoardDocument {
  return {
    schemaVersion: 2,
    viewport: { ...EMPTY_WHITEBOARD_VIEWPORT },
    projects: [],
    nodes: [],
    edges: [],
    console: { provider: "codex" }
  };
}

export const createEmptyWhiteboardStore = createEmptyGlobalBoardDocument;

export function rebaseGlobalBoardDocument(
  base: GlobalBoardDocument,
  local: GlobalBoardDocument,
  remote: GlobalBoardDocument
): GlobalBoardDocument {
  return mergeGlobalBoardDocument(base, local, remote);
}

export function resolveGlobalBoardConflict(
  base: GlobalBoardDocument,
  local: GlobalBoardDocument,
  remote: GlobalBoardDocument,
  resolution: "local" | "remote"
): GlobalBoardDocument {
  return mergeGlobalBoardDocument(base, local, remote, resolution);
}

function mergeGlobalBoardDocument(
  base: GlobalBoardDocument,
  local: GlobalBoardDocument,
  remote: GlobalBoardDocument,
  resolution?: "local" | "remote"
): GlobalBoardDocument {
  const next = {
    schemaVersion: 2 as const,
    viewport: mergeChangedValue(base.viewport, local.viewport, remote.viewport, "视口", resolution),
    projects: mergeRecordsById(base.projects, local.projects, remote.projects, "项目", resolution),
    nodes: mergeRecordsById(base.nodes, local.nodes, remote.nodes, "节点", resolution),
    edges: mergeRecordsById(base.edges, local.edges, remote.edges, "边", resolution),
    console: mergeChangedValue(base.console, local.console, remote.console, "console", resolution)
  };
  try {
    return validateSchemaTwoDocument(next);
  } catch (error) {
    if (error instanceof WhiteboardMigrationError) {
      throw new WhiteboardRebaseError(`无法无损合并并发白板修改：${error.message}`);
    }
    throw error;
  }
}

export function normalizeGlobalBoardDocument(input: unknown): GlobalBoardDocument {
  if (input === undefined) return createEmptyGlobalBoardDocument();
  if (!isRecord(input)) migrationFailure("白板数据必须是对象。");
  if (input.schemaVersion === 2) return validateSchemaTwoDocument(input);
  if (looksLikeSchemaOne(input)) return migrateSchemaOne(input);
  migrationFailure("白板数据既不是 schema one，也不是 schema two。");
}

export const normalizeWhiteboardStore = normalizeGlobalBoardDocument;

export function validateSchemaTwoDocument(input: unknown): GlobalBoardDocument {
  if (!isRecord(input) || input.schemaVersion !== 2) migrationFailure("白板不是 schema two 文档。");
  assertKeys(input, ["schemaVersion", "viewport", "projects", "nodes", "edges", "console"], "schema-two 白板");
  const viewport = parseViewport(input.viewport, "schema-two 视口");
  if (!Array.isArray(input.projects) || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
    migrationFailure("schema-two 白板缺少项目、节点或边数组。");
  }
  const consoleState = requiredRecord(input.console, "schema-two 白板缺少 console。");
  assertKeys(consoleState, ["provider"], "schema-two console");
  const provider = parseProvider(consoleState.provider, "schema-two console provider 无效。");

  const projects: ProjectFrame[] = [];
  const projectIds = new Set<string>();
  const rootPaths = new Set<string>();
  for (const value of input.projects) {
    const frame = parseSchemaTwoFrame(value);
    assertUnique(projectIds, frame.id, `项目 ID 重复：${frame.id}`);
    assertUnique(rootPaths, frame.rootPath, `项目根路径重复：${frame.rootPath}`);
    projects.push(frame);
  }

  const projectById = new Map(projects.map((project) => [project.id, project]));
  const nodes: WhiteboardNode[] = [];
  const nodeIds = new Set<string>();
  for (const value of input.nodes) {
    const node = parseSchemaTwoNode(value, projectById);
    if (projectIds.has(node.id)) migrationFailure(`节点 ID 与项目 ID 冲突：${node.id}`);
    assertUnique(nodeIds, node.id, `节点 ID 重复：${node.id}`);
    nodes.push(node);
  }

  const edges: WhiteboardEdge[] = [];
  const edgeIds = new Set<string>();
  for (const value of input.edges) {
    const edge = parseSchemaTwoEdge(value, nodeIds);
    assertUnique(edgeIds, edge.id, `边 ID 重复：${edge.id}`);
    edges.push(edge);
  }

  return { schemaVersion: 2, viewport, projects, nodes, edges, console: { provider } };
}

export function createProjectFrame(rootPath: string, name: string, id = createId("project")): ProjectFrame {
  return {
    id,
    name: name.trim() || pathBasename(rootPath),
    rootPath,
    position: { x: 120, y: 120 },
    size: { ...DEFAULT_FRAME_SIZE },
    zIndex: 0
  };
}

export function appendProjectFrame(
  document: GlobalBoardDocument,
  rootPath: string,
  name: string,
  id = createId("project")
): GlobalBoardDocument {
  const right = document.projects.reduce(
    (maximum, frame) => Math.max(maximum, frame.position.x + frame.size.width),
    -40
  );
  const zIndex = document.projects.reduce((maximum, frame) => Math.max(maximum, frame.zIndex), -1) + 1;
  const frame = createProjectFrame(rootPath, name, id);
  frame.position.x = document.projects.length === 0 ? 120 : right + 160;
  frame.zIndex = zIndex;
  return { ...document, projects: [...document.projects, frame] };
}

export function renameProjectFrame(document: GlobalBoardDocument, projectId: string, name: string): GlobalBoardDocument {
  const nextName = name.trim();
  if (!nextName) return document;
  let changed = false;
  const projects = document.projects.map((frame) => {
    if (frame.id !== projectId || frame.name === nextName) return frame;
    changed = true;
    return { ...frame, name: nextName };
  });
  return changed ? { ...document, projects } : document;
}

export function removeProjectFrame(document: GlobalBoardDocument, projectId: string): GlobalBoardDocument {
  if (!document.projects.some((frame) => frame.id === projectId)) return document;
  const removedNodeIds = new Set(document.nodes.filter((node) => node.projectId === projectId).map((node) => node.id));
  return {
    ...document,
    projects: document.projects.filter((frame) => frame.id !== projectId),
    nodes: document.nodes.filter((node) => node.projectId !== projectId),
    edges: document.edges.filter(
      (edge) => !removedNodeIds.has(edge.sourceNodeId) && !removedNodeIds.has(edge.targetNodeId)
    )
  };
}

export function deleteWhiteboardNode(document: GlobalBoardDocument, nodeId: string): GlobalBoardDocument {
  if (!document.nodes.some((node) => node.id === nodeId)) return document;
  return {
    ...document,
    nodes: document.nodes.filter((node) => node.id !== nodeId),
    edges: document.edges.filter((edge) => edge.sourceNodeId !== nodeId && edge.targetNodeId !== nodeId)
  };
}

export function createAgentPlaceholder(
  document: GlobalBoardDocument,
  projectId: string,
  provider: WhiteboardProvider,
  requestedPosition?: CanvasPoint,
  id = createId("agent")
): GlobalBoardDocument {
  const frame = document.projects.find((candidate) => candidate.id === projectId);
  if (!frame) return document;
  const fallback = nextProjectSlot(document, frame);
  const position = clampNodeToFrame(requestedPosition ?? fallback, NODE_DEFAULTS.agent, frame);
  const node: WhiteboardAgentNode = {
    id,
    kind: "agent",
    projectId,
    position,
    size: { ...NODE_DEFAULTS.agent },
    zIndex: nextNodeZIndex(document),
    provider,
    workingDirectory: frame.rootPath,
    sessionId: null,
    sessionIdVerified: false,
    runtimeState: "exited"
  };
  return { ...document, nodes: [...document.nodes, node] };
}

export function createTerminalNode(
  document: GlobalBoardDocument,
  projectId: string,
  requestedPosition?: CanvasPoint,
  id = createId("terminal")
): GlobalBoardDocument {
  const frame = document.projects.find((candidate) => candidate.id === projectId);
  if (!frame) return document;
  const position = clampNodeToFrame(requestedPosition ?? nextProjectSlot(document, frame), NODE_DEFAULTS.terminal, frame);
  const node: WhiteboardTerminalNode = {
    id,
    kind: "terminal",
    projectId,
    position,
    size: { ...NODE_DEFAULTS.terminal },
    zIndex: nextNodeZIndex(document),
    workingDirectory: frame.rootPath,
    runtimeId: null
  };
  return { ...document, nodes: [...document.nodes, node] };
}

export function createNoteNode(
  document: GlobalBoardDocument,
  projectId: string,
  requestedPosition?: CanvasPoint,
  id = createId("note")
): GlobalBoardDocument {
  const frame = document.projects.find((candidate) => candidate.id === projectId);
  if (!frame) return document;
  const position = clampNodeToFrame(requestedPosition ?? nextProjectSlot(document, frame), NODE_DEFAULTS.note, frame);
  const node: WhiteboardNoteNode = {
    id,
    kind: "note",
    projectId,
    position,
    size: { ...NODE_DEFAULTS.note },
    zIndex: nextNodeZIndex(document),
    markdown: "# 新便签\n\n"
  };
  return { ...document, nodes: [...document.nodes, node] };
}

export function createGlobalLabel(
  document: GlobalBoardDocument,
  position: CanvasPoint,
  id = createId("label")
): GlobalBoardDocument {
  const node: WhiteboardLabelNode = {
    id,
    kind: "label",
    projectId: null,
    position: { ...position },
    size: { ...NODE_DEFAULTS.label },
    zIndex: nextNodeZIndex(document),
    text: "",
    color: "#2f6f5e",
    fontSize: 56
  };
  return { ...document, nodes: [...document.nodes, node] };
}

export function moveProjectFrame(
  document: GlobalBoardDocument,
  projectId: string,
  nextPosition: CanvasPoint
): GlobalBoardDocument {
  const frame = document.projects.find((candidate) => candidate.id === projectId);
  if (!frame || !isFinitePoint(nextPosition)) return document;
  const delta = { x: nextPosition.x - frame.position.x, y: nextPosition.y - frame.position.y };
  if (delta.x === 0 && delta.y === 0) return document;
  return {
    ...document,
    projects: document.projects.map((candidate) => candidate.id === projectId
      ? { ...candidate, position: { ...nextPosition } }
      : candidate),
    nodes: document.nodes.map((node) => node.projectId === projectId
      ? { ...node, position: { x: node.position.x + delta.x, y: node.position.y + delta.y } }
      : node)
  };
}

export function moveWhiteboardNode(
  document: GlobalBoardDocument,
  nodeId: string,
  nextPosition: CanvasPoint
): GlobalBoardDocument {
  if (!isFinitePoint(nextPosition)) return document;
  let changed = false;
  const nodes = document.nodes.map((node) => {
    if (node.id !== nodeId) return node;
    if (node.position.x === nextPosition.x && node.position.y === nextPosition.y) return node;
    changed = true;
    return { ...node, position: { ...nextPosition } };
  });
  return changed ? { ...document, nodes } : document;
}

export function containProjectFrame(frame: ProjectFrame, nodes: WhiteboardNode[]): ProjectFrame {
  const owned = nodes.filter((node) => node.projectId === frame.id);
  if (owned.length === 0) return frame;
  const left = Math.min(frame.position.x, ...owned.map((node) => node.position.x - FRAME_INSET.left));
  const top = Math.min(frame.position.y, ...owned.map((node) => node.position.y - FRAME_INSET.top));
  const right = Math.max(
    frame.position.x + frame.size.width,
    ...owned.map((node) => node.position.x + node.size.width + FRAME_INSET.right)
  );
  const bottom = Math.max(
    frame.position.y + frame.size.height,
    ...owned.map((node) => node.position.y + node.size.height + FRAME_INSET.bottom)
  );
  if (left === frame.position.x && top === frame.position.y && right === frame.position.x + frame.size.width && bottom === frame.position.y + frame.size.height) {
    return frame;
  }
  return {
    ...frame,
    position: { x: left, y: top },
    size: { width: right - left, height: bottom - top }
  };
}

export function resizeProjectFrame(
  frame: ProjectFrame,
  proposed: Pick<ProjectFrame, "position" | "size">,
  nodes: WhiteboardNode[]
): ProjectFrame {
  if (!isFinitePoint(proposed.position) || !isFiniteSize(proposed.size)) return frame;
  if (proposed.size.width < DEFAULT_FRAME_SIZE.width || proposed.size.height < DEFAULT_FRAME_SIZE.height) return frame;
  const right = proposed.position.x + proposed.size.width;
  const bottom = proposed.position.y + proposed.size.height;
  const containsAll = nodes.filter((node) => node.projectId === frame.id).every((node) => (
    node.position.x >= proposed.position.x + FRAME_RESIZE_CLEARANCE.left
    && node.position.y >= proposed.position.y + FRAME_RESIZE_CLEARANCE.top
    && node.position.x + node.size.width <= right - FRAME_RESIZE_CLEARANCE.right
    && node.position.y + node.size.height <= bottom - FRAME_RESIZE_CLEARANCE.bottom
  ));
  return containsAll ? { ...frame, position: { ...proposed.position }, size: { ...proposed.size } } : frame;
}

export function reassignWhiteboardNode(
  document: GlobalBoardDocument,
  nodeId: string,
  targetProjectId: string | null
): GlobalBoardDocument {
  const node = document.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.projectId === targetProjectId) return document;
  if (targetProjectId === null) {
    if (node.kind !== "label") return document;
    return {
      ...document,
      nodes: document.nodes.map((candidate) => candidate.id === nodeId && candidate.kind === "label"
        ? { ...candidate, projectId: null }
        : candidate)
    };
  }
  const frame = document.projects.find((candidate) => candidate.id === targetProjectId);
  if (!frame) return document;
  const position = nextProjectSlot(document, frame);
  const reassigned = reassignNodeModel(node, frame, position);
  const nodes = document.nodes.map((candidate) => candidate.id === nodeId ? reassigned : candidate);
  const projects = document.projects.map((candidate) => candidate.id === frame.id
    ? containProjectFrame(candidate, nodes)
    : candidate);
  return { ...document, projects, nodes };
}

export function isActiveAgent(node: WhiteboardNode): boolean {
  return node.kind === "agent" && ["starting", "running", "waiting"].includes(node.runtimeState);
}

function migrateSchemaOne(source: Record<string, unknown>): GlobalBoardDocument {
  assertKeys(source, ["projects", "activeProjectId", "boards"], "schema-one 白板");
  if (!Array.isArray(source.projects)) migrationFailure("schema-one projects 必须是数组。");
  const rawProjects = source.projects;
  const rawBoards = requiredRecord(source.boards, "schema-one boards 必须是对象。");
  if (source.activeProjectId !== null && source.activeProjectId !== undefined && typeof source.activeProjectId !== "string") {
    migrationFailure("schema-one activeProjectId 无效。");
  }
  const projectIds = new Set<string>();
  const rootPaths = new Set<string>();
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const projects: ProjectFrame[] = [];
  const nodes: WhiteboardNode[] = [];
  const edges: WhiteboardEdge[] = [];
  let nextFrameX = 120;

  for (const rawProject of rawProjects) {
    if (!isRecord(rawProject)) migrationFailure("项目记录无效。");
    assertKeys(rawProject, ["id", "name", "rootPath", "createdAt"], "schema-one 项目");
    const id = requiredString(rawProject.id, "项目缺少 ID。");
    const rootPath = requiredString(rawProject.rootPath, `项目 ${id} 缺少根路径。`);
    assertUnique(projectIds, id, `项目 ID 重复：${id}`);
    assertUnique(rootPaths, rootPath, `项目根路径重复：${rootPath}`);
    const name = requiredString(rawProject.name, `项目 ${id} 缺少名称。`);
    if (rawProject.createdAt !== undefined && typeof rawProject.createdAt !== "string") {
      migrationFailure(`项目 ${id} 的 createdAt 无效。`);
    }
    const rawBoard = rawBoards[id];
    if (!isRecord(rawBoard) || rawBoard.schemaVersion !== 1) migrationFailure(`项目 ${id} 缺少 schema-one 白板。`);
    assertKeys(rawBoard, ["schemaVersion", "projectId", "viewport", "nodes", "edges"], `项目 ${id} 的 schema-one 白板`);
    if (rawBoard.projectId !== id) migrationFailure(`项目 ${id} 的白板所有权不明确。`);
    parseViewport(rawBoard.viewport, `项目 ${id} 的 schema-one 视口`);
    if (!Array.isArray(rawBoard.nodes) || !Array.isArray(rawBoard.edges)) migrationFailure(`项目 ${id} 的白板结构无效。`);

    const oldNodes = rawBoard.nodes.map((rawNode) => migrateNode(rawNode, id, rootPath, nodeIds));
    const conflictingNode = oldNodes.find((node) => projectIds.has(node.id));
    if (conflictingNode) migrationFailure(`节点 ID 与项目 ID 冲突：${conflictingNode.id}`);
    const minX = oldNodes.length ? Math.min(...oldNodes.map((node) => node.position.x)) : 0;
    const minY = oldNodes.length ? Math.min(...oldNodes.map((node) => node.position.y)) : 0;
    const maxRight = oldNodes.length ? Math.max(...oldNodes.map((node) => node.position.x + node.size.width)) : 0;
    const maxBottom = oldNodes.length ? Math.max(...oldNodes.map((node) => node.position.y + node.size.height)) : 0;
    const shiftX = nextFrameX + FRAME_INSET.left - Math.min(0, minX);
    const shiftY = 120 + FRAME_INSET.top - Math.min(0, minY);
    const migratedNodes = oldNodes.map((node) => ({
      ...node,
      position: { x: node.position.x + shiftX, y: node.position.y + shiftY }
    }));
    const frame: ProjectFrame = {
      id,
      name,
      rootPath,
      position: { x: nextFrameX, y: 120 },
      size: {
        width: Math.max(DEFAULT_FRAME_SIZE.width, maxRight - Math.min(0, minX) + 96),
        height: Math.max(DEFAULT_FRAME_SIZE.height, maxBottom - Math.min(0, minY) + 152)
      },
      zIndex: projects.length
    };
    const boardNodeIds = new Set(migratedNodes.map((node) => node.id));
    const migratedEdges = rawBoard.edges.map((rawEdge) => migrateEdge(rawEdge, edgeIds, boardNodeIds));
    projects.push(frame);
    nodes.push(...migratedNodes);
    edges.push(...migratedEdges);
    nextFrameX = frame.position.x + frame.size.width + 160;
  }

  const boardKeys = Object.keys(rawBoards);
  if (boardKeys.length !== projectIds.size || boardKeys.some((id) => !projectIds.has(id))) {
    migrationFailure("schema-one boards 与项目列表不一一对应。");
  }
  const conflictingIdentity = nodes.find((node) => projectIds.has(node.id));
  if (conflictingIdentity) migrationFailure(`节点 ID 与项目 ID 冲突：${conflictingIdentity.id}`);
  if (source.activeProjectId !== null && source.activeProjectId !== undefined && !projectIds.has(source.activeProjectId)) {
    migrationFailure("schema-one activeProjectId 指向未知项目。");
  }

  return {
    schemaVersion: 2,
    viewport: { ...EMPTY_WHITEBOARD_VIEWPORT },
    projects,
    nodes,
    edges,
    console: { provider: "codex" }
  };
}

function migrateNode(
  input: unknown,
  projectId: string,
  rootPath: string,
  nodeIds: Set<string>
): WhiteboardNode {
  if (!isRecord(input)) migrationFailure(`项目 ${projectId} 含有无效节点。`);
  const id = requiredString(input.id, `项目 ${projectId} 含有缺少 ID 的节点。`);
  assertUnique(nodeIds, id, `节点 ID 重复：${id}`);
  const kind = parseKind(input.kind, `节点 ${id} 的类型无效。`);
  if (!kind) migrationFailure(`节点 ${id} 的类型无效。`);
  const commonKeys = ["id", "kind", "x", "y", "width", "height", "zIndex"];
  const kindKeys: Record<WhiteboardNodeKind, string[]> = {
    agent: ["provider", "workingDirectory", "sessionId", "sessionIdVerified", "runtimeState"],
    terminal: ["workingDirectory", "runtimeId"],
    note: ["markdown"],
    label: ["text", "color", "fontSize"]
  };
  assertKeys(input, [...commonKeys, ...kindKeys[kind]], `schema-one 节点 ${id}`);
  const base = {
    id,
    projectId,
    position: {
      x: requiredFinite(input.x, `节点 ${id} 的 x 无效。`),
      y: requiredFinite(input.y, `节点 ${id} 的 y 无效。`)
    },
    size: parseNodeSize(kind, input.width, input.height, `节点 ${id}`),
    zIndex: parseZIndex(input.zIndex, `节点 ${id} 的 zIndex 无效。`)
  };
  if (kind === "note") {
    if (typeof input.markdown !== "string") migrationFailure(`节点 ${id} 的 markdown 无效。`);
    return { ...base, kind, markdown: input.markdown };
  }
  if (kind === "label") {
    if (typeof input.text !== "string") migrationFailure(`节点 ${id} 的文本无效。`);
    if (input.fontSize !== 56) migrationFailure(`节点 ${id} 的字号无效。`);
    return {
      ...base,
      kind,
      text: input.text,
      color: parseLabelColor(input.color, `节点 ${id} 的颜色无效。`),
      fontSize: 56
    };
  }
  const workingDirectory = requiredString(input.workingDirectory, `节点 ${id} 缺少工作目录。`);
  if (workingDirectory !== rootPath) migrationFailure(`节点 ${id} 的工作目录不属于项目 ${projectId}。`);
  if (kind === "terminal") {
    parseNullableString(input.runtimeId, `节点 ${id} 的 runtimeId 无效。`, true);
    return {
      ...base,
      kind,
      workingDirectory: rootPath,
      runtimeId: null
    };
  }
  if (typeof input.sessionIdVerified !== "boolean") migrationFailure(`节点 ${id} 的 sessionIdVerified 无效。`);
  parseRuntimeState(input.runtimeState, `节点 ${id} 的 runtimeState 无效。`);
  return {
    ...base,
    kind,
    provider: parseProvider(input.provider, `节点 ${id} 的 provider 无效。`),
    workingDirectory: rootPath,
    sessionId: parseNullableString(input.sessionId, `节点 ${id} 的 sessionId 无效。`, true),
    sessionIdVerified: input.sessionIdVerified,
    runtimeState: "exited"
  };
}

function migrateEdge(input: unknown, edgeIds: Set<string>, boardNodeIds: Set<string>): WhiteboardEdge {
  if (!isRecord(input)) migrationFailure("schema-one 白板含有无效边。");
  assertKeys(input, ["id", "source", "target"], "schema-one 边");
  const id = requiredString(input.id, "schema-one 边缺少 ID。");
  assertUnique(edgeIds, id, `边 ID 重复：${id}`);
  const sourceNodeId = requiredString(input.source, `边 ${id} 缺少起点。`);
  const targetNodeId = requiredString(input.target, `边 ${id} 缺少终点。`);
  if (!boardNodeIds.has(sourceNodeId) || !boardNodeIds.has(targetNodeId)) migrationFailure(`边 ${id} 存在孤立端点。`);
  return { id, sourceNodeId, targetNodeId };
}

function parseSchemaTwoFrame(input: unknown): ProjectFrame {
  const source = requiredRecord(input, "schema-two 项目记录无效。");
  assertKeys(source, ["id", "name", "rootPath", "position", "size", "zIndex"], "schema-two 项目");
  const id = requiredString(source.id, "schema-two 项目缺少 ID。");
  const rootPath = requiredString(source.rootPath, `项目 ${id} 缺少根路径。`);
  return {
    id,
    name: requiredString(source.name, `项目 ${id} 缺少名称。`),
    rootPath,
    position: parsePoint(source.position, `项目 ${id} 的位置`),
    size: parseFrameSize(source.size, `项目 ${id} 的尺寸`),
    zIndex: parseZIndex(source.zIndex, `项目 ${id} 的 zIndex 无效。`)
  };
}

function parseSchemaTwoNode(input: unknown, projects: Map<string, ProjectFrame>): WhiteboardNode {
  const source = requiredRecord(input, "schema-two 节点记录无效。");
  const id = requiredString(source.id, "schema-two 节点缺少 ID。");
  const kind = parseKind(source.kind, `节点 ${id} 的类型无效。`);
  const commonKeys = ["id", "kind", "projectId", "position", "size", "zIndex"];
  const kindKeys: Record<WhiteboardNodeKind, string[]> = {
    agent: ["provider", "workingDirectory", "sessionId", "sessionIdVerified", "runtimeState"],
    terminal: ["workingDirectory", "runtimeId"],
    note: ["markdown"],
    label: ["text", "color", "fontSize"]
  };
  assertKeys(source, [...commonKeys, ...kindKeys[kind]], `schema-two 节点 ${id}`);
  const rawProjectId = source.projectId === null ? null : requiredString(source.projectId, `节点 ${id} 缺少 projectId。`);
  const frame = rawProjectId ? projects.get(rawProjectId) : undefined;
  if (kind !== "label" && !frame) migrationFailure(`节点 ${id} 指向未知项目。`);
  if (kind === "label" && rawProjectId !== null && !frame) migrationFailure(`标签 ${id} 指向未知项目。`);
  const base = {
    id,
    projectId: rawProjectId,
    position: parsePoint(source.position, `节点 ${id} 的位置`),
    size: parseSchemaTwoNodeSize(kind, source.size, `节点 ${id} 的尺寸`),
    zIndex: parseZIndex(source.zIndex, `节点 ${id} 的 zIndex 无效。`)
  };
  if (kind === "note") {
    if (!frame || typeof source.markdown !== "string") migrationFailure(`节点 ${id} 的便签内容无效。`);
    return { ...base, kind, projectId: frame.id, markdown: source.markdown };
  }
  if (kind === "label") {
    if (typeof source.text !== "string" || source.fontSize !== 56) migrationFailure(`标签 ${id} 的文本或字号无效。`);
    return {
      ...base,
      kind,
      projectId: frame?.id ?? null,
      text: source.text,
      color: parseLabelColor(source.color, `标签 ${id} 的颜色无效。`),
      fontSize: 56
    };
  }
  if (!frame) migrationFailure(`节点 ${id} 指向未知项目。`);
  const workingDirectory = requiredString(source.workingDirectory, `节点 ${id} 缺少工作目录。`);
  if (workingDirectory !== frame.rootPath) migrationFailure(`节点 ${id} 的工作目录与项目根路径不一致。`);
  if (kind === "terminal") {
    parseNullableString(source.runtimeId, `节点 ${id} 的 runtimeId 无效。`);
    return {
      ...base,
      kind,
      projectId: frame.id,
      workingDirectory,
      runtimeId: null
    };
  }
  if (typeof source.sessionIdVerified !== "boolean") migrationFailure(`节点 ${id} 的 sessionIdVerified 无效。`);
  parseRuntimeState(source.runtimeState, `节点 ${id} 的 runtimeState 无效。`);
  return {
    ...base,
    kind,
    projectId: frame.id,
    provider: parseProvider(source.provider, `节点 ${id} 的 provider 无效。`),
    workingDirectory,
    sessionId: parseNullableString(source.sessionId, `节点 ${id} 的 sessionId 无效。`),
    sessionIdVerified: source.sessionIdVerified,
    runtimeState: "exited"
  };
}

function parseSchemaTwoEdge(input: unknown, nodeIds: Set<string>): WhiteboardEdge {
  const source = requiredRecord(input, "schema-two 边记录无效。");
  assertKeys(source, ["id", "sourceNodeId", "targetNodeId"], "schema-two 边");
  const id = requiredString(source.id, "schema-two 边缺少 ID。");
  const sourceNodeId = requiredString(source.sourceNodeId, `边 ${id} 缺少起点。`);
  const targetNodeId = requiredString(source.targetNodeId, `边 ${id} 缺少终点。`);
  if (!nodeIds.has(sourceNodeId) || !nodeIds.has(targetNodeId)) migrationFailure(`边 ${id} 存在孤立端点。`);
  return { id, sourceNodeId, targetNodeId };
}

function reassignNodeModel(node: WhiteboardNode, frame: ProjectFrame, position: CanvasPoint): WhiteboardNode {
  if (node.kind === "agent") return { ...node, projectId: frame.id, position, workingDirectory: frame.rootPath };
  if (node.kind === "terminal") return { ...node, projectId: frame.id, position, workingDirectory: frame.rootPath };
  if (node.kind === "note") return { ...node, projectId: frame.id, position };
  return { ...node, projectId: frame.id, position };
}

function nextProjectSlot(document: GlobalBoardDocument, frame: ProjectFrame): CanvasPoint {
  const ownedCount = document.nodes.filter((node) => node.projectId === frame.id).length;
  return {
    x: frame.position.x + FRAME_INSET.left + (ownedCount % 2) * 560,
    y: frame.position.y + FRAME_INSET.top + Math.floor(ownedCount / 2) * 380
  };
}

function clampNodeToFrame(position: CanvasPoint, size: CanvasSize, frame: ProjectFrame): CanvasPoint {
  return {
    x: clamp(position.x, frame.position.x + FRAME_INSET.left, frame.position.x + frame.size.width - FRAME_INSET.right - size.width),
    y: clamp(position.y, frame.position.y + FRAME_INSET.top, frame.position.y + frame.size.height - FRAME_INSET.bottom - size.height)
  };
}

function nextNodeZIndex(document: GlobalBoardDocument): number {
  return document.nodes.reduce((maximum, node) => Math.max(maximum, node.zIndex), 0) + 1;
}

function parseFrameSize(value: unknown, context: string): CanvasSize {
  const size = requiredRecord(value, `${context}无效。`);
  assertKeys(size, ["width", "height"], context);
  const width = requiredFinite(size.width, `${context} width 无效。`);
  const height = requiredFinite(size.height, `${context} height 无效。`);
  if (width < DEFAULT_FRAME_SIZE.width || height < DEFAULT_FRAME_SIZE.height) {
    migrationFailure(`${context}小于允许的最小尺寸。`);
  }
  return { width, height };
}

function parseSchemaTwoNodeSize(kind: WhiteboardNodeKind, value: unknown, context: string): CanvasSize {
  const size = requiredRecord(value, `${context}无效。`);
  assertKeys(size, ["width", "height"], context);
  return parseNodeSize(kind, size.width, size.height, context);
}

function parseNodeSize(kind: WhiteboardNodeKind, widthValue: unknown, heightValue: unknown, context: string): CanvasSize {
  const width = requiredFinite(widthValue, `${context} width 无效。`);
  const height = requiredFinite(heightValue, `${context} height 无效。`);
  if (width < NODE_MINIMUMS[kind].width || height < NODE_MINIMUMS[kind].height) {
    migrationFailure(`${context}小于允许的最小尺寸。`);
  }
  return { width, height };
}

function parsePoint(value: unknown, context: string): CanvasPoint {
  const point = requiredRecord(value, `${context}无效。`);
  assertKeys(point, ["x", "y"], context);
  return {
    x: requiredFinite(point.x, `${context} x 无效。`),
    y: requiredFinite(point.y, `${context} y 无效。`)
  };
}

function parseViewport(value: unknown, context: string): GlobalBoardDocument["viewport"] {
  const viewport = requiredRecord(value, `${context}无效。`);
  assertKeys(viewport, ["x", "y", "zoom"], context);
  const zoom = requiredFinite(viewport.zoom, `${context} zoom 无效。`);
  if (zoom < 0.2 || zoom > 2) migrationFailure(`${context} zoom 超出范围。`);
  return {
    x: requiredFinite(viewport.x, `${context} x 无效。`),
    y: requiredFinite(viewport.y, `${context} y 无效。`),
    zoom
  };
}

function parseLabelColor(value: unknown, message: string): string {
  if (typeof value !== "string" || !LABEL_COLORS.has(value.toLowerCase())) migrationFailure(message);
  return value;
}

function parseKind(value: unknown, message: string): WhiteboardNodeKind {
  if (value !== "agent" && value !== "terminal" && value !== "note" && value !== "label") migrationFailure(message);
  return value;
}

function parseProvider(value: unknown, message: string): WhiteboardProvider {
  if (value !== "codex" && value !== "claude-code") migrationFailure(message);
  return value;
}

function parseRuntimeState(value: unknown, message: string): WhiteboardRuntimeState {
  if (value !== "starting" && value !== "running" && value !== "waiting" && value !== "exited" && value !== "failed") {
    migrationFailure(message);
  }
  return value;
}

function parseZIndex(value: unknown, message: string): number {
  const result = requiredFinite(value, message);
  if (!Number.isInteger(result) || result < 0) migrationFailure(message);
  return result;
}

function looksLikeSchemaOne(input: unknown): input is Record<string, unknown> {
  return isRecord(input) && Array.isArray(input.projects) && isRecord(input.boards);
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) migrationFailure(message);
  return value;
}

function parseNullableString(value: unknown, message: string, allowUndefined = false): string | null {
  if (value === null || (allowUndefined && value === undefined)) return null;
  return requiredString(value, message);
}

function requiredFinite(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) migrationFailure(message);
  return value;
}

function requiredRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) migrationFailure(message);
  return value;
}

function assertKeys(source: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(source).find((key) => !allowedKeys.has(key));
  if (unexpected) migrationFailure(`${context} 含有未知字段：${unexpected}`);
}

function assertUnique(values: Set<string>, value: string, message: string): void {
  if (values.has(value)) migrationFailure(message);
  values.add(value);
}

function mergeRecordsById<T extends { id: string }>(
  base: readonly T[],
  local: readonly T[],
  remote: readonly T[],
  label: string,
  resolution?: "local" | "remote"
): T[] {
  const baseById = new Map(base.map((value) => [value.id, value]));
  const localById = new Map(local.map((value) => [value.id, value]));
  const remoteById = new Map(remote.map((value) => [value.id, value]));
  const order = [
    ...remote.map((value) => value.id),
    ...local.map((value) => value.id).filter((id) => !remoteById.has(id))
  ];
  const result: T[] = [];
  for (const id of order) {
    const value = mergeChangedValue(
      baseById.get(id),
      localById.get(id),
      remoteById.get(id),
      `${label} ${id}`,
      resolution
    );
    if (value !== undefined) result.push(value);
  }
  return result;
}

function mergeChangedValue<T>(
  base: T,
  local: T,
  remote: T,
  label: string,
  resolution?: "local" | "remote"
): T {
  if (structurallyEqual(local, base)) return remote;
  if (structurallyEqual(remote, base) || structurallyEqual(local, remote)) return local;
  if (resolution === "local") return local;
  if (resolution === "remote") return remote;
  throw new WhiteboardRebaseError(`${label} 同时被本地和外部修改。`, [label]);
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

function migrationFailure(message: string): never {
  throw new WhiteboardMigrationError(message);
}

function createId(prefix: "project" | "agent" | "terminal" | "note" | "label" | "edge"): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFinitePoint(value: CanvasPoint): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y);
}

function isFiniteSize(value: CanvasSize): boolean {
  return Number.isFinite(value.width) && Number.isFinite(value.height);
}

function pathBasename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || path;
}
