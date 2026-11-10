/**
 * Provider-neutral contracts. Everything outside src/drivers speaks only these
 * types. No vendor message format, tool schema format or model name appears here.
 */
import type { z } from 'zod';

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolResultMessage {
  callId: string;
  name: string;
  content: string;
  isError: boolean;
}

export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ToolCall[] }
  | { role: 'tool'; results: ToolResultMessage[] };

/** JSON Schema object generated from a Zod schema. Drivers wrap it in their own envelope. */
export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Cost in USD when the provider or gateway reports it. */
  costUsd?: number;
}

export interface CompletionRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxOutputTokens: number;
}

export interface CompletionResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stop: 'tools' | 'end' | 'max_tokens';
}

export interface TokenCount {
  tokens: number;
  method: 'provider-count-endpoint' | 'local-tokenizer-estimate';
}

/** The only surface the core loop sees of a model provider. */
export interface Driver {
  /** Label for logs/reports only. Never passed to hooks, checks or tools. */
  readonly label: string;
  readonly model: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  /** Count input tokens for a request without running it (used for the shadow baseline). */
  countTokens(req: CompletionRequest): Promise<TokenCount>;
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export interface FieldSpec {
  name: string;
  type: 'string' | 'email' | 'integer' | 'number' | 'boolean' | 'enum' | 'datetime' | 'uuid';
  required?: boolean;
  unique?: boolean;
  min?: number;
  max?: number;
  values?: string[];
  default?: string | number | boolean;
}

export interface TaskFile {
  id: string;
  mode: 'greenfield' | 'brownfield';
  /** Directory (relative to harness root) the run is allowed to write in. */
  target: string;
  /** Brownfield only: pristine source copied into target at run start. */
  source?: string;
  goal: string;
  resource?: { name: string; plural: string; fields: FieldSpec[] };
  behaviours: string[];
  /** Brownfield: contract changes the task explicitly allows, e.g. "GET /v1/products". */
  allowBreaking?: string[];
}

// ---------------------------------------------------------------------------
// Run state (owned by the harness, never by the model)
// ---------------------------------------------------------------------------

export type TestStatus = 'pass' | 'fail';

export interface LedgerEntry {
  testFile: string;
  status: TestStatus;
  at: string;
  /** Test files observed failing at least once by the harness runner. */
  everRed: boolean;
}

export interface TestRunResult {
  ran: boolean;
  files: { file: string; status: TestStatus; failures: string[] }[];
  passed: number;
  failed: number;
  rawLogPath: string;
  /** Full human-readable runner output (what a harness without compact returns would show). */
  rawOutput: string;
  error?: string;
}

export interface RunState {
  runId: string;
  task: TaskFile;
  workspace: string;
  turn: number;
  ledger: Map<string, LedgerEntry>;
  writtenFiles: Set<string>;
  /** Harness-owned files the model may read but never write (scaffold lib, configs). */
  protectedFiles: Set<string>;
  /** true when context fetchers + compaction are disabled (token baseline run). */
  baseline: boolean;
  events: HookEventRecord[];
  finishAttempts: number;
  contractSnapshotPath?: string;
}

export interface HookEventRecord {
  turn: number;
  hook: string;
  phase: 'pre' | 'post';
  tool: string;
  decision: HookDecision['decision'];
  feedback?: string;
}

// ---------------------------------------------------------------------------
// Tools (plugins in src/registry/tools)
// ---------------------------------------------------------------------------

export interface ToolOutput {
  /** Compact text the model sees in JIT mode. */
  summary: string;
  /** Full output. Written to disk and referenced by path in JIT mode; shown verbatim in baseline mode. */
  raw?: string;
  isError?: boolean;
}

export interface HarnessServices {
  runTests(files?: string[]): Promise<TestRunResult>;
  runChecks(opts?: { runtime?: boolean }): Promise<CheckReport>;
  /** Fetch a section of the standards doc on demand. */
  standardsSection(id: string): string;
  resolveInWorkspace(rel: string): string;
  log(name: string, content: string): string;
}

export interface ToolContext {
  state: RunState;
  services: HarnessServices;
  /** true when the harness runs with context fetchers + compaction disabled. */
  baseline: boolean;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** write = mutates workspace files; exec = runs a harness subprocess; control = loop control. */
  kind: 'read' | 'write' | 'exec' | 'control';
  /** For write tools: workspace-relative path this call will write. Hooks use it. */
  writes?: (args: z.infer<S>) => string;
  /**
   * Read tools: identity of the context this call fetched (e.g. "file:src/app.ts:1-40").
   * Compaction keeps the latest result per key verbatim until a write to that path makes it stale.
   */
  contextKey?: (args: z.infer<S>) => string;
  /** For write tools: the full file content the call would produce, so pre-hooks can inspect it before anything touches disk. */
  preview?: (args: z.infer<S>, ctx: ToolContext) => Promise<string> | string;
  run(args: z.infer<S>, ctx: ToolContext): Promise<ToolOutput>;
}

// ---------------------------------------------------------------------------
// Hooks (built-ins in src/hooks, plugins in src/registry/hooks)
// ---------------------------------------------------------------------------

export interface HookDecision {
  decision: 'block' | 'record' | 'pass';
  feedback?: string;
}

export interface HookEvent {
  phase: 'pre' | 'post';
  tool: ToolDef;
  args: unknown;
  /** Workspace-relative path for write tools. */
  path?: string;
  /** File contents the write would produce (pre) or produced (post). */
  nextContent?: string;
  output?: ToolOutput;
  ctx: ToolContext;
}

export interface HookDef {
  name: string;
  phase: 'pre' | 'post';
  appliesTo(tool: ToolDef): boolean;
  run(ev: HookEvent): Promise<HookDecision> | HookDecision;
}

// ---------------------------------------------------------------------------
// Standards checks (built-ins in src/checks/rules, plugins in registry/linters + registry/validators)
// ---------------------------------------------------------------------------

export type CheckStatus = 'pass' | 'fail' | 'unproven' | 'n/a';

export interface Finding {
  file: string;
  line?: number;
  ok: boolean;
  message: string;
}

export interface RuleResult {
  status: CheckStatus;
  /** Unit of measure, e.g. "handlers", "error paths", "routes", "errors". */
  unit: string;
  passed: number;
  total: number;
  findings: Finding[];
  note?: string;
  /** Optional custom summary text, e.g. "0 errors". */
  display?: string;
}

export interface RouteInfo {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  file: string;
  line: number;
  /** ts-morph node of the final handler function (typed loosely to keep plugins decoupled). */
  handler: import('ts-morph').ArrowFunction | import('ts-morph').FunctionExpression | import('ts-morph').FunctionDeclaration | undefined;
  handlerText: string;
}

export interface RuleContext {
  apiDir: string;
  project: import('ts-morph').Project;
  /** Non-test source files under <apiDir>/src. */
  sourceFiles: import('ts-morph').SourceFile[];
  /** Test files under <apiDir>/tests and *.test.ts. */
  testFiles: import('ts-morph').SourceFile[];
  routes: RouteInfo[];
  rel(file: string): string;
  options: { runtime: boolean; contractBaseline?: string; allowBreaking?: string[] };
  /** Run a command through the harness subprocess runner. */
  exec(cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface RuleDef {
  id: string;
  /** standard = API standard from section 02, orm = ORM validator, lint = extra linter rule, gate = harness gate. */
  category: 'standard' | 'orm' | 'lint' | 'gate';
  description: string;
  run(ctx: RuleContext): Promise<RuleResult> | RuleResult;
}

export interface CheckReport {
  apiDir: string;
  rules: { id: string; category: RuleDef['category']; result: RuleResult }[];
  verdictPct: number;
  green: boolean;
  unproven: string[];
  text: string;
}
