/**
 * E5 unit tests: progress ledger pure functions (record/fold/summarize).
 */
import { describe, it, expect } from 'vitest';
import {
  emptyLedger,
  buildEntry,
  recordTurn,
  summarizeLedger,
  buildProgressHeadline,
  LEDGER_MAX_DETAIL,
} from '../src/progress-ledger';

describe('E5: progress-ledger', () => {
  describe('buildEntry', () => {
    it('dedupes + caps files/commands', () => {
      const e = buildEntry(1, ['a.ts', 'a.ts', 'b.ts'], ['npm test', 'npm test', 'npm run build']);
      expect(e.filesTouched).toEqual(['a.ts', 'b.ts']);
      expect(e.commandsRun).toEqual(['npm test', 'npm run build']);
    });

    it('drops empty/non-string items + truncates long ones', () => {
      const long = 'x'.repeat(200);
      const e = buildEntry(1, [long, '', '  ', 'ok'], []);
      expect(e.filesTouched).toEqual([long.substring(0, 120), 'ok']);
    });
  });

  describe('recordTurn + fold (replace, not stack)', () => {
    it('keeps detail entries up to the window without folding', () => {
      let l = emptyLedger();
      for (let i = 1; i <= LEDGER_MAX_DETAIL; i++) {
        l = recordTurn(l, buildEntry(i, [`f${i}.ts`], [`cmd${i}`]));
      }
      expect(l.entries.length).toBe(LEDGER_MAX_DETAIL);
      expect(l.folded.turns).toBe(0);
    });

    it('folds the oldest into the aggregate once over capacity (replace, not append)', () => {
      let l = emptyLedger();
      for (let i = 1; i <= LEDGER_MAX_DETAIL + 2; i++) {
        l = recordTurn(l, buildEntry(i, [`f${i}.ts`], [`cmd${i}`]));
      }
      // detail window holds only the last LEDGER_MAX_DETAIL turns
      expect(l.entries.length).toBe(LEDGER_MAX_DETAIL);
      expect(l.entries[0].turn).toBe(3); // turns 1+2 folded out
      // aggregate merged the folded turns (replace representation, not stacked prose)
      expect(l.folded.turns).toBe(2);
      expect(l.folded.filesTouched).toEqual(['f1.ts', 'f2.ts']);
      expect(l.folded.commandsRun).toEqual(['cmd1', 'cmd2']);
    });

    it('folding dedupes files across folded turns (aggregate merge)', () => {
      let l = emptyLedger();
      // two turns touch the same file
      l = recordTurn(l, buildEntry(1, ['shared.ts'], ['a']));
      l = recordTurn(l, buildEntry(2, ['shared.ts', 'b.ts'], ['b']));
      // force fold by exceeding window
      for (let i = 3; i <= LEDGER_MAX_DETAIL + 2; i++) {
        l = recordTurn(l, buildEntry(i, [`f${i}.ts`], [`cmd${i}`]));
      }
      // shared.ts appears once in the aggregate despite two folded turns touching it
      expect(l.folded.filesTouched.filter((f) => f === 'shared.ts').length).toBe(1);
    });

    it('keeps the NEWEST folded files past the cap, drops the oldest (review follow-up)', () => {
      // 20 turns, each a distinct file → 14 folded (> MAX_SUMMARY_FILES=12).
      // slice(-MAX) keeps the newest 12; the earliest 2 are dropped (not frozen).
      let l = emptyLedger();
      for (let i = 1; i <= 20; i++) {
        l = recordTurn(l, buildEntry(i, [`f${i}.ts`], [`cmd${i}`]));
      }
      expect(l.folded.turns).toBe(14);
      // detail window holds turns 15-20; folded holds 1-14, capped to newest 12 (3-14).
      expect(l.folded.filesTouched).toContain('f14.ts'); // newest folded present
      expect(l.folded.filesTouched).toContain('f3.ts');  // 12th-newest folded present
      expect(l.folded.filesTouched).not.toContain('f1.ts'); // oldest dropped
      expect(l.folded.filesTouched).not.toContain('f2.ts'); // 2nd-oldest dropped
      expect(l.folded.filesTouched.length).toBeLessThanOrEqual(12);
      // the most recent turns survive in the detail window
      expect(l.entries[l.entries.length - 1].filesTouched).toContain('f20.ts');
    });
  });

  describe('summarizeLedger', () => {
    it('returns structured JSON with folded + recent + open surfaces', () => {
      let l = emptyLedger();
      l = recordTurn(l, buildEntry(1, ['a.ts'], ['npm test'], 'passed'));
      const s = summarizeLedger(l);
      const parsed = JSON.parse(s);
      expect(parsed.foldedTurns).toBe(0);
      expect(parsed.recentTurns[0]).toEqual({ turn: 1, files: ['a.ts'], commands: ['npm test'], evidence: 'passed' });
      expect(Array.isArray(parsed.openItems)).toBe(true);
    });

    it('empty/undefined ledger → valid JSON, no throw', () => {
      expect(() => summarizeLedger(undefined)).not.toThrow();
      const parsed = JSON.parse(summarizeLedger(undefined));
      expect(parsed.foldedTurns).toBe(0);
      expect(parsed.recentTurns).toEqual([]);
    });

    it('includes folded history once turns age out', () => {
      let l = emptyLedger();
      for (let i = 1; i <= LEDGER_MAX_DETAIL + 1; i++) {
        l = recordTurn(l, buildEntry(i, [`f${i}.ts`], [`cmd${i}`]));
      }
      const parsed = JSON.parse(summarizeLedger(l));
      expect(parsed.foldedTurns).toBe(1);
      expect(parsed.filesTouchedSoFar).toEqual(['f1.ts']);
    });
  });

  describe('buildEntry volume caps', () => {
    it('caps files at 8 and commands at 4', () => {
      const files = Array.from({ length: 12 }, (_, i) => `f${i}.ts`);
      const cmds = Array.from({ length: 6 }, (_, i) => `c${i}`);
      const e = buildEntry(1, files, cmds);
      expect(e.filesTouched.length).toBe(8);
      expect(e.commandsRun.length).toBe(4);
      expect(e.filesTouched).toEqual(files.slice(0, 8));
      expect(e.commandsRun).toEqual(cmds.slice(0, 4));
    });
  });

  describe('buildProgressHeadline', () => {
    it('empty ledger → Turn 0 with plural defaults', () => {
      expect(buildProgressHeadline(emptyLedger())).toBe('Turn 0 · 0 files · 0 commands');
    });

    it('singular for 1 file / 1 command', () => {
      const l = recordTurn(emptyLedger(), buildEntry(1, ['a.ts'], ['npm test']));
      expect(buildProgressHeadline(l)).toBe('Turn 1 · 1 file · 1 command');
    });

    it('plural for many files/commands', () => {
      const l = recordTurn(emptyLedger(), buildEntry(1, ['a.ts', 'b.ts', 'c.ts'], ['t1', 't2', 't3']));
      expect(buildProgressHeadline(l)).toBe('Turn 1 · 3 files · 3 commands');
    });

    it('folded note uses singular/plural correctly', () => {
      let l = emptyLedger();
      for (let i = 1; i <= LEDGER_MAX_DETAIL + 1; i++) {
        l = recordTurn(l, buildEntry(i, [`f${i}.ts`], [`c${i}`]));
      }
      expect(buildProgressHeadline(l)).toContain('1 earlier turn folded');
      for (let i = LEDGER_MAX_DETAIL + 2; i <= LEDGER_MAX_DETAIL + 3; i++) {
        l = recordTurn(l, buildEntry(i, [`f${i}.ts`], [`c${i}`]));
      }
      expect(buildProgressHeadline(l)).toContain('3 earlier turns folded');
    });
  });
});
