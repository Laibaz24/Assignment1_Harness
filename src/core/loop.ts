/**
 * The harness loop.
 *
 *   model (via Driver) -> tool call -> pre-hooks (block|record|pass) -> tool -> post-hooks
 *        ^                                                                         |
 *        +---------------- compact result (summary + path to raw log) <------------+
 *
 * The loop ends only when the model calls a control tool (finish) AND the
 * deterministic gates are green: all tests pass, every written source file has an
 * observed-red covering test, and the standards checks read 100%.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { buildContext, runCheck } from '../checks/engine.ts';
import { extractContract } from '../checks/contract.ts';
import { BUILTIN_HOOKS } from '../hooks/index.ts';
import { compactHistory, type CallInfo } from './compaction.ts';
import { finishGates, type GateResult } from './gates.ts';
import { frontLoadedContext, standardsSection, systemPrompt, taskBrief } from './prompts.ts';
import { HARNESS_ROOT, loadRegistry } from './registry.ts';
import { writeRunReport, writeTokenReport, type TurnTokens } from './report.ts';
import { recordLedger, runTests } from './runner.ts';
import type { CompletionRequest, Driver, HarnessServices, HookDef, Message, RunState, ToolCall, ToolContext, ToolDef, ToolResultMessage, ToolSpec } from './types.ts';
import { loadTask, prepareWorkspace, relPosix, resolveInside } from './workspace.ts';

export interface RunOptions {
  taskPath: string;
  driver: Driver;
  baseline?: boolean;
  maxTurns?: number;
  out?: string;
  /** Count the shadow baseline per turn (default true in JIT mode). */
  shadow?: boolean;
  quiet?: boolean;
}

export interface RunResult {
  runId: string;
  runDir: string;
  green: boolean;
  turns: number;
  tokenReport: string;
  workspace: string;
}

const MAX_OUTPUT_TOKENS = 8192;

export async function runTask(opts: RunOptions): Promise<RunResult> {
  const task = loadTask(opts.taskPath);
  const baseline = opts.baseline ?? false;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runId = `${task.id}-${opts.driver.label}${baseline ? '-baseline' : ''}-${stamp}`;
  const runDir = join(HARNESS_ROOT, 'runs', runId);
  const logDir = join(runDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const say = (s: string): void => {
    if (!opts.quiet) process.stdout.write(s + '\n');
    appendFileSync(join(runDir, 'console.log'), s + '\n');
  };

  const registry = await loadRegistry();
  const hooks: HookDef[] = [...BUILTIN_HOOKS, ...registry.hooks];
  const tools = new Map<string, ToolDef>(registry.tools.map((t) => [t.name, t]));
  const toolSpecs: ToolSpec[] = registry.tools.map((t) => {
    const { $schema: _drop, ...parameters } = z.toJSONSchema(t.schema, { io: 'input' }) as Record<string, unknown>;
    return { name: t.name, description: t.description, parameters };
  });

  const ws = prepareWorkspace(task, runId, opts.out);
  const state: RunState = {
    runId,
    task,
    workspace: ws.dir,
    turn: 0,
    ledger: new Map(),
    writtenFiles: new Set(),
    protectedFiles: ws.protectedFiles,
    baseline,
    events: [],
    finishAttempts: 0,
  };
  say(`run ${runId}`);
  say(`driver=${opts.driver.label} model=${opts.driver.model} mode=${baseline ? 'baseline (fetchers+compaction off)' : 'jit'} workspace=${relPosix(HARNESS_ROOT, ws.dir)}`);
  say(`registry: ${registry.tools.length} tools, ${registry.rules.length} extra rules, ${registry.hooks.length} extra hooks`);

  if (task.mode === 'brownfield') {
    const contract = await extractContract(buildContext(ws.dir, {}).routes);
    state.contractSnapshotPath = join(runDir, 'contract.before.json');
    writeFileSync(state.contractSnapshotPath, JSON.stringify(contract, null, 2));
    say(`contract snapshot: ${Object.keys(contract.routes).length} routes -> ${relPosix(HARNESS_ROOT, state.contractSnapshotPath)}`);
  }

  let logSeq = 0;
  const services: HarnessServices = {
    async runTests(files) {
      const r = await runTests(ws.dir, files, services.log);
      recordLedger(state, r);
      return r;
    },
    runChecks(o) {
      const checkOpts: Parameters<typeof runCheck>[1] = { runtime: o?.runtime ?? true, extraRules: registry.rules };
      if (state.contractSnapshotPath) checkOpts.contractBaseline = state.contractSnapshotPath;
      if (task.allowBreaking) checkOpts.allowBreaking = task.allowBreaking;
      return runCheck(ws.dir, checkOpts);
    },
    standardsSection,
    resolveInWorkspace: (rel) => resolveInside(ws.dir, rel),
    log(name, content) {
      logSeq++;
      const file = join(logDir, `${String(logSeq).padStart(3, '0')}-${name.replace(/[^a-z0-9_-]/gi, '_')}.txt`);
      writeFileSync(file, content);
      return relPosix(HARNESS_ROOT, file);
    },
  };
  const ctx: ToolContext = { state, services, baseline };

  // Two views of the same conversation: what the model gets (JIT, compacted) and
  // what a fetcher-less harness would send (front-loaded, raw, uncompacted).
  const jitSystem = systemPrompt(task);
  const baselineSystem = jitSystem + '\n' + frontLoadedContext(ws.dir);
  const brief: Message = { role: 'user', content: taskBrief(task) };
  const history: Message[] = [brief];
  const rawHistory: Message[] = [brief];
  const turns: TurnTokens[] = [];
  let baselineMethod = baseline ? 'measured (this run is the baseline)' : '';
  let green = false;
  let gate: GateResult | undefined;
  let idle = 0;
  let readOnlyStreak = 0;
  const STALL_TURNS = 6;
  const transcript = join(runDir, 'transcript.jsonl');
  // What each call read or wrote, from the tool definitions themselves (no tool names in core).
  const callInfo: CallInfo = (call) => {
    const tool = tools.get(call.name);
    const parsed = tool?.schema.safeParse(call.args);
    if (!tool || !parsed?.success) return {};
    const readKey = tool.contextKey?.(parsed.data);
    const writePath = tool.writes?.(parsed.data);
    return { ...(readKey !== undefined ? { readKey } : {}), ...(writePath !== undefined ? { writePath } : {}) };
  };

  for (let turn = 1; turn <= (opts.maxTurns ?? 40); turn++) {
    state.turn = turn;
    const req: CompletionRequest = baseline
      ? { system: baselineSystem, messages: rawHistory, tools: toolSpecs, maxOutputTokens: MAX_OUTPUT_TOKENS }
      : { system: jitSystem, messages: compactHistory(history, callInfo), tools: toolSpecs, maxOutputTokens: MAX_OUTPUT_TOKENS };
    // Baseline and actual are counted with the SAME method so the ratio compares like with like.
    // The provider-reported figure (different tokenizer, hidden tool prompt) is kept alongside.
    let shadowTokens: number | undefined;
    let actualSameMethod: number | undefined;
    if (!baseline && opts.shadow !== false) {
      const c = await opts.driver.countTokens({ system: baselineSystem, messages: rawHistory, tools: toolSpecs, maxOutputTokens: MAX_OUTPUT_TOKENS });
      const a = await opts.driver.countTokens(req);
      shadowTokens = c.tokens;
      actualSameMethod = a.tokens;
      baselineMethod = `shadow baseline on the same trajectory; baseline and actual both counted with ${c.method}`;
    }
    const res = await opts.driver.complete(req);
    turns.push({
      turn,
      actualInputTokens: actualSameMethod ?? res.usage.inputTokens,
      providerReportedInputTokens: res.usage.inputTokens,
      baselineInputTokens: baseline ? res.usage.inputTokens : (shadowTokens ?? 0),
      outputTokens: res.usage.outputTokens,
      costUsd: res.usage.costUsd ?? 0,
      tools: res.toolCalls.map((c) => c.name),
    });
    appendFileSync(transcript, JSON.stringify({ turn, input: { system_chars: req.system.length, messages: req.messages.length, tokens: res.usage.inputTokens, shadow_baseline_tokens: shadowTokens }, output: { text: res.text.slice(0, 2000), toolCalls: res.toolCalls.map((c) => ({ name: c.name, args: summarizeArgs(c.args) })), stop: res.stop } }) + '\n');

    const assistant: Message = { role: 'assistant', content: res.text, toolCalls: res.toolCalls };
    history.push(assistant);
    rawHistory.push(assistant);
    if (res.toolCalls.length === 0) {
      idle++;
      say(`[turn ${turn}] no tool call${res.text ? `: ${res.text.slice(0, 120)}` : ''}`);
      if (idle >= 3) {
        say('stopping: model stopped calling tools (task NOT complete; gates never confirmed green)');
        break;
      }
      const nudge: Message = { role: 'user', content: 'Continue with tool calls. The task ends only when you call finish and the harness gates are green.' };
      history.push(nudge);
      rawHistory.push(nudge);
      continue;
    }
    idle = 0;
    readOnlyStreak = res.toolCalls.every((c) => tools.get(c.name)?.kind === 'read') ? readOnlyStreak + 1 : 0;

    const results: ToolResultMessage[] = [];
    const rawResults: ToolResultMessage[] = [];
    let finished = false;
    for (const call of res.toolCalls) {
      const out = await executeCall(call, tools, hooks, ctx, say);
      let content = out.content;
      let raw = out.raw;
      if (out.control && !out.isError) {
        state.finishAttempts++;
        gate = await finishGates(state, services);
        say(`[turn ${turn}] finish -> gates ${gate.green ? 'GREEN' : 'NOT green'}`);
        content = gate.green ? `ACCEPTED: all gates green.\n${gate.lines.join('\n')}` : `NOT DONE - gates failing:\n${gate.lines.join('\n')}`;
        raw = `${content}\n--- test output ---\n${gate.tests?.rawOutput ?? ''}\n--- standards check ---\n${gate.check?.text ?? ''}`;
        if (baseline) content = raw;
        else content += `\n(full output: ${services.log('finish-gates', raw)})`;
        if (gate.green) finished = true;
      }
      results.push({ callId: call.id, name: call.name, content, isError: out.isError });
      rawResults.push({ callId: call.id, name: call.name, content: raw, isError: out.isError });
    }
    history.push({ role: 'tool', results });
    rawHistory.push({ role: 'tool', results: rawResults });
    if (finished) {
      green = true;
      break;
    }
    if (readOnlyStreak >= STALL_TURNS) {
      readOnlyStreak = 0;
      say(`[turn ${turn}] stall detector: ${STALL_TURNS} read-only turns, nudging`);
      state.events.push({ turn, hook: 'stall-detector', phase: 'post', tool: '(loop)', decision: 'record', feedback: `${STALL_TURNS} consecutive read-only turns` });
      const nudge: Message = {
        role: 'user',
        content: `You have only read files for ${STALL_TURNS} turns. Your latest read of every file is still in the conversation above (pinned until that file changes) - do not re-read. Next step: write the test file, then run_tests.`,
      };
      history.push(nudge);
      rawHistory.push(nudge);
    }
  }

  // Final verdict is recomputed by the harness, whatever happened in the loop.
  if (!gate || !green) gate = await finishGates(state, services);
  green = gate.green;
  const tokenReport = writeTokenReport({ runId, task: task.id, driver: opts.driver, baseline, baselineMethod, turns });
  writeRunReport({ runId, runDir, state, gate, driver: opts.driver, baseline, tokenReport, turns: turns.length });
  say(`verdict: ${green ? 'GREEN' : 'NOT GREEN'} after ${turns.length} turns`);
  say(`token report: ${tokenReport}`);
  say(`run report: ${relPosix(HARNESS_ROOT, join(runDir, 'report.md'))}`);
  return { runId, runDir, green, turns: turns.length, tokenReport, workspace: ws.dir };
}

function summarizeArgs(args: unknown): unknown {
  if (typeof args !== 'object' || args === null) return args;
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === 'string' && v.length > 200 ? `<${v.length} chars>` : v]));
}

interface CallOutcome {
  content: string;
  raw: string;
  isError: boolean;
  control: boolean;
}

async function executeCall(call: ToolCall, tools: Map<string, ToolDef>, hooks: HookDef[], ctx: ToolContext, say: (s: string) => void): Promise<CallOutcome> {
  const { state, services } = ctx;
  const fail = (msg: string): CallOutcome => ({ content: msg, raw: msg, isError: true, control: false });
  const tool = tools.get(call.name);
  if (!tool) return fail(`unknown tool "${call.name}". Available: ${[...tools.keys()].join(', ')}`);
  const parsed = tool.schema.safeParse(call.args);
  if (!parsed.success) return fail(`invalid arguments for ${tool.name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  const args: unknown = parsed.data;

  let path: string | undefined;
  let nextContent: string | undefined;
  try {
    if (tool.kind === 'write') {
      path = tool.writes?.(args);
      if (path !== undefined) resolveInside(state.workspace, path);
      nextContent = tool.preview ? await tool.preview(args, ctx) : undefined;
    }
  } catch (e) {
    return fail(`BLOCKED: ${String(e instanceof Error ? e.message : e)}`);
  }
  const label = `${tool.name}${path ? ` ${path}` : ''}`;
  const event = { phase: 'pre' as const, tool, args, ctx, ...(path !== undefined ? { path } : {}), ...(nextContent !== undefined ? { nextContent } : {}) };

  for (const h of hooks.filter((h) => h.phase === 'pre' && h.appliesTo(tool))) {
    const d = await h.run(event);
    state.events.push({ turn: state.turn, hook: h.name, phase: 'pre', tool: tool.name, decision: d.decision, ...(d.feedback ? { feedback: d.feedback } : {}) });
    if (d.decision === 'block') {
      say(`[turn ${state.turn}] ${label} -> BLOCKED by ${h.name}`);
      return fail(`BLOCKED by ${h.name}: ${d.feedback ?? ''}`);
    }
  }

  let output;
  try {
    output = await tool.run(args, ctx);
  } catch (e) {
    return fail(`${tool.name} failed: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`);
  }
  const notes: string[] = [];
  let isError = output.isError ?? false;
  for (const h of hooks.filter((h) => h.phase === 'post' && h.appliesTo(tool))) {
    const d = await h.run({ ...event, phase: 'post', output });
    state.events.push({ turn: state.turn, hook: h.name, phase: 'post', tool: tool.name, decision: d.decision, ...(d.feedback ? { feedback: d.feedback } : {}) });
    if (d.feedback && d.decision !== 'pass') notes.push(`[${h.name}] ${d.feedback}`);
    if (d.decision === 'block') isError = true;
  }
  say(`[turn ${state.turn}] ${label} -> ${isError ? 'error' : 'ok'}${notes.length ? ' (+hook feedback)' : ''}`);
  const tail = notes.length ? `\n${notes.join('\n')}` : '';
  const rawText = (output.raw ?? output.summary) + tail;
  let content = output.summary + tail;
  if (ctx.baseline) content = rawText;
  else if (output.raw !== undefined) content += `\n(full output: ${services.log(tool.name, output.raw)})`;
  return { content, raw: rawText, isError, control: tool.kind === 'control' };
}

