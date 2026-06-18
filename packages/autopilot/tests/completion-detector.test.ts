import { describe, it, expect } from 'vitest';
import { isTaskComplete, hasNoActionableTask } from '../src/completion-detector';

describe('completion-detector', () => {
  describe('isTaskComplete', () => {
    // Chinese completion signals
    it('detects 所有任务已完成', () => {
      expect(isTaskComplete('经过以上步骤，所有任务已完成。')).toBe(true);
    });

    it('detects 任务全部完成', () => {
      expect(isTaskComplete('任务全部完成，代码已经通过测试。')).toBe(true);
    });

    it('detects 全部步骤已完成', () => {
      expect(isTaskComplete('全部步骤已完成。')).toBe(true);
    });

    // X-13: CRLF / lone CR line endings (Windows agents commonly emit \r\n)
    it('detects completion after CRLF (\\r\\n) boundary', () => {
      expect(isTaskComplete('前面的工作已完成。\r\n所有任务已完成')).toBe(true);
    });

    it('detects completion after lone CR (\\r) boundary', () => {
      expect(isTaskComplete('previous step done.\r所有任务已完成')).toBe(true);
    });

    // English completion signals
    it('detects "all tasks completed"', () => {
      expect(isTaskComplete('I have finished everything. All tasks completed successfully.')).toBe(true);
    });

    it('detects "all steps completed"', () => {
      expect(isTaskComplete('All steps completed. The refactoring is done.')).toBe(true);
    });

    it('detects "task is complete"', () => {
      expect(isTaskComplete('The task is complete. No further action needed.')).toBe(true);
    });

    it('detects "everything is done"', () => {
      expect(isTaskComplete('Everything is done, all tests pass.')).toBe(true);
    });

    // Case insensitivity
    it('detects case-insensitive "ALL TASKS COMPLETED"', () => {
      expect(isTaskComplete('ALL TASKS COMPLETED!')).toBe(true);
    });

    // False positives rejection
    it('rejects negated mention: "not all tasks completed"', () => {
      expect(isTaskComplete('I have not all tasks completed yet, still working.')).toBe(false);
    });

    it('rejects "I will complete the task"', () => {
      expect(isTaskComplete('I will complete the task in the next step.')).toBe(false);
    });

    it('rejects generic progress messages', () => {
      expect(isTaskComplete('I am making progress on the refactoring.')).toBe(false);
    });

    it('rejects "let me continue"', () => {
      expect(isTaskComplete('Let me continue working on this.')).toBe(false);
    });

    it('rejects completion strings inside code blocks', () => {
      const msg = '```\nconsole.log("all tasks completed")\n```\nI need to keep working.';
      expect(isTaskComplete(msg)).toBe(false);
    });

    // Edge cases
    it('returns false for undefined', () => {
      expect(isTaskComplete(undefined)).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isTaskComplete('')).toBe(false);
    });

    it('returns false for whitespace only', () => {
      expect(isTaskComplete('   \n\t  ')).toBe(false);
    });

    it('returns false for normal work output', () => {
      expect(isTaskComplete('I have updated the file at src/index.ts and added the new function.')).toBe(false);
    });

    // stopHookActive
    it('returns false when stopHookActive is true regardless of message', () => {
      expect(isTaskComplete('所有任务已完成', true)).toBe(false);
    });

    it('detects completion when stopHookActive is false', () => {
      expect(isTaskComplete('所有任务已完成', false)).toBe(true);
    });
  });

  describe('hasNoActionableTask', () => {
    // ─── Positive: greeting help-offers ───────────────────────
    it('detects Chinese greeting help-offer "有什么可以帮你的吗"', () => {
      expect(hasNoActionableTask('你好！请问有什么可以帮你的吗？')).toBe(true);
    });

    it('detects Chinese greeting asking what to do', () => {
      expect(hasNoActionableTask('你好，请问需要我帮你做什么吗？')).toBe(true);
    });

    it('detects Chinese "有什么我可以帮忙的"', () => {
      expect(hasNoActionableTask('您好！有什么我可以帮忙的吗？')).toBe(true);
    });

    it('detects English "How can I help you"', () => {
      expect(hasNoActionableTask('Hello! How can I help you today?')).toBe(true);
    });

    it('detects English "What can I do for you"', () => {
      expect(hasNoActionableTask('Hi! What can I do for you?')).toBe(true);
    });

    it('detects English "What would you like me to do"', () => {
      expect(hasNoActionableTask('Hello! What would you like me to do?')).toBe(true);
    });

    it('detects English "is there anything I can help with"', () => {
      expect(hasNoActionableTask('Hi there! Is there anything I can help you with?')).toBe(true);
    });

    // ─── Positive: explicit no-task / request for task ────────
    it('detects Chinese explicit no-task "没有具体的任务"', () => {
      expect(hasNoActionableTask('目前没有具体的任务需要执行。')).toBe(true);
    });

    it('detects Chinese request for specific task', () => {
      expect(hasNoActionableTask('请告诉我具体的需求，我才能开始工作。')).toBe(true);
    });

    it('detects English "I don\'t have a specific task"', () => {
      expect(hasNoActionableTask("I don't have a specific task to work on right now.")).toBe(true);
    });

    it('detects English "there is no task"', () => {
      expect(hasNoActionableTask('There is no task for me to perform at the moment.')).toBe(true);
    });

    it('detects English "nothing to do"', () => {
      expect(hasNoActionableTask('There is nothing to do here.')).toBe(true);
    });

    // ─── Negative: real task work must NOT match ──────────────
    it('rejects normal work output', () => {
      expect(hasNoActionableTask('I have updated the file at src/index.ts and added the new function.')).toBe(false);
    });

    it('rejects "let me continue"', () => {
      expect(hasNoActionableTask('Let me continue working on this.')).toBe(false);
    });

    it('rejects "I will complete the task"', () => {
      expect(hasNoActionableTask('I will complete the task in the next step.')).toBe(false);
    });

    it('rejects generic progress messages', () => {
      expect(hasNoActionableTask('I am making progress on the refactoring.')).toBe(false);
    });

    it('rejects Chinese mid-task progress', () => {
      expect(hasNoActionableTask('我正在重构用户认证模块，已完成一半。')).toBe(false);
    });

    it('rejects "还没有完成任务" (incomplete, not "no task")', () => {
      expect(hasNoActionableTask('还没有完成任务，继续工作。')).toBe(false);
    });

    it('rejects "请继续执行下一步"', () => {
      expect(hasNoActionableTask('请继续执行下一步。')).toBe(false);
    });

    it('rejects "I have a task to do next" (affirmative, not negated)', () => {
      expect(hasNoActionableTask('I have a task to do next.')).toBe(false);
    });

    it('rejects "I don\'t have the workaround ready" (no task/thing keyword)', () => {
      expect(hasNoActionableTask("I don't have the workaround ready, let me try another approach.")).toBe(false);
    });

    // ─── Edge cases ───────────────────────────────────────────
    it('returns false for undefined', () => {
      expect(hasNoActionableTask(undefined)).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(hasNoActionableTask('')).toBe(false);
    });

    it('returns false for whitespace only', () => {
      expect(hasNoActionableTask('   \n\t  ')).toBe(false);
    });

    it('rejects no-task phrases inside code blocks', () => {
      const msg = '```\nconsole.log("what can I do for you")\n```\nI need to keep working.';
      expect(hasNoActionableTask(msg)).toBe(false);
    });
  });
});
