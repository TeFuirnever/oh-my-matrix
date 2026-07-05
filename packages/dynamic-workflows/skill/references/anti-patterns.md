# Anti-patterns

Read this before finalizing a `.prose` program. Each item causes real failures.

## Structure

- **Giant prompt session**: One session = one job. Split multi-step logic into
  multiple sessions.
- **Programs over 50 lines**: Extract into `block` definitions.
- **Parallel with dependencies**:
  ```prose
  # BAD — b depends on a
  parallel:
    a = session "Get data"
    b = session "Process" context: a
  # GOOD
  let a = session "Get data"
  let b = session "Process" context: a
  ```

## Correctness

- **Hardcoded paths**: Use `input` variables, not `/Users/foo/project/src`.
- **Missing `input` declarations**: `{task}` without `input task:` fails compile.
- **Vague AI conditions**: Write `if **all tests pass with zero failures**:`
  not `if **things look good**:`.
- **Skipping validation**: Always validate (via `prose compile` or manual check)
  before executing.
- **Parallel writes to shared files**: Assign disjoint ownership or run those
  branches sequentially.

## Execution integrity

- **Pretend execution**: If no workflow runtime or session-spawn tool exists, do
  not claim that agents ran. Return a plan-only result.
- **Direct fallback for complex DAGs**: Do not use raw session spawning for
  recursive search, tournaments, or 6+ agents. Enable OpenProse instead.
- **Using Dynamic Workflows as Autopilot**: Do not turn a one-shot DAG into an
  open-ended autonomous loop. Use the host Autopilot for continuous recovery or
  cross-turn continuation.
