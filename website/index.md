---
layout: home

hero:
  name: "oh-my-matrix"
  text: "OpenClaw-native orchestration extension suite"
  tagline: Persistent workflow modes (ralph / autopilot / team) for any OpenClaw-compatible host. Zero runtime dependencies. Single tarball.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Reference
      link: /reference/

features:
  - title: Three Workflow Modes
    details: ralph for iterative execution loops, autopilot for autonomous multi-step pipelines, team for parallel agent delegation.
  - title: Zero Dependencies
    details: Hand-written JSON-RPC MCP servers. No @modelcontextprotocol/sdk. Single JS-only tarball, no Rust crates.
  - title: Structured Error Codes
    details: Stable OMM_E_* identifiers on every failure path. Hosts branch programmatically — no substring matching.
  - title: Cross-Process Safety
    details: O_EXCL file locking across plugin process and all MCP server processes sharing the same state root.
---

## Install

```bash
# Unpack the omm bundle into your host's resources directory
tar -xzf omm-suite-0.3.0-alpha.2.tgz -C resources/
```

See the [Getting Started guide](/guide/getting-started) for full setup instructions including MCP server registration and mode activation.
