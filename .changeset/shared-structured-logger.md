---
'@oh-my-matrix/permission-policy': patch
---

Extract the shared structured logger (log/warn/error/logWithContext) from the per-package duplicates in autopilot + dynamic-workflows. The old per-package env var names remain accepted: level resolves AUTOPILOT_LOG_LEVEL → DYNAMIC_WORKFLOWS_LOG_LEVEL → LOG_LEVEL (first set wins); format is json if either AUTOPILOT_LOG_FORMAT or DYNAMIC_WORKFLOWS_LOG_FORMAT is 'json'. In a single process that sets only one package's vars (the normal case), behavior is unchanged from that package's original logger.
