/**
 * Deterministic subprocess runner. Every git, test, type-check and probe command
 * the harness runs goes through here. The model never gets a shell.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { HARNESS_ROOT } from './registry.ts';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function exec(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? HARNESS_ROOT,
      env: { ...process.env, ...opts.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs ?? 180_000);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

/** Run a Node CLI shipped in the harness's own node_modules (no npx, no shell: works the same on Windows and POSIX). */
export const BIN = {
  tsc: join(HARNESS_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
  vitest: join(HARNESS_ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
};

export function node(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  return exec(process.execPath, args, opts);
}

/** Run a TypeScript script through the tsx loader resolved from the harness root. */
export function nodeTs(script: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
  return exec(process.execPath, ['--import', 'tsx', script, ...args], { cwd: HARNESS_ROOT, ...opts });
}
