---
name: omm-ping
description: Minimal omm runtime smoke test
user-invocable: true
disable-model-invocation: true
command-dispatch: tool
command-tool: omm_ping
command-arg-mode: raw
version: 0.1.0
---

# omm-ping

Use this skill to verify the omm plugin command path. It dispatches directly to the `omm_ping` tool and writes a smoke record under the omm state root.
