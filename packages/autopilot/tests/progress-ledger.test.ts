/**
 * E5 unit tests: progress ledger pure functions (record/fold/summarize).
 */
import { describe, it, expect } from 'vitest';
import {
  emptyLedger,
  buildEntry,
  recordTurn,
  summarizeLedger,
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
});
