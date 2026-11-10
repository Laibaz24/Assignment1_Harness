/**
 * Pre-write: observed red before source edits.
 * A file under src/ is refused until a test that covers it exists AND the harness's
 * own runner has recorded that test failing in this run. The model's word never counts.
 */
import { defineHook } from '../core/plugin.ts';
import { isSourcePath, testsCovering } from './test-map.ts';

export default defineHook({
  name: 'observed-red',
  phase: 'pre',
  appliesTo: (tool) => tool.kind === 'write',
  run(ev) {
    const p = ev.path;
    if (p === undefined || !isSourcePath(p)) return { decision: 'pass' };
    const { state } = ev.ctx;
    const tests = testsCovering(state.workspace, p);
    if (tests.length === 0) {
      return {
        decision: 'block',
        feedback: `REFUSED ${p}: no test covers it. Write a test first (tests/<name>.test.ts containing the line "// @covers ${p}"), call run_tests and see it fail, then edit ${p}.`,
      };
    }
    const red = tests.filter((t) => state.ledger.get(t)?.everRed === true);
    if (red.length === 0) {
      return {
        decision: 'block',
        feedback: `REFUSED ${p}: covering tests [${tests.join(', ')}] have not been observed failing by the harness runner. Call run_tests; a covering test must fail before ${p} can change.`,
      };
    }
    return { decision: 'record', feedback: `observed red: ${red.join(', ')}` };
  },
});
