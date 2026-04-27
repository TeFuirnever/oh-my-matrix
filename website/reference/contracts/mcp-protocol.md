# MCP Protocol Contract（MCP 协议合同）

> Defines the JSON-RPC interface for the omm-state MCP server.

## Transport

- **Protocol**: Stdio — one JSON-RPC 2.0 message per line over stdin/stdout
- **Line delimiter**: `\n` (CRLF-tolerant via `createInterface({ crlfDelay: Infinity })`)
- **Encoding**: UTF-8

## Server Identity

- **Name**: `omm-state`
- **Version**: `0.2.0`
- **Protocol version**: MCP 2024-11-05

## Handshake（握手）

### 1. Client → Server: `initialize`

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": { "name": "...", "version": "..." }
  }
}
```

### 2. Server → Client: response

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": { "tools": {} },
    "serverInfo": { "name": "omm-state", "version": "0.2.0" }
  }
}
```

### 3. Client → Server: `notifications/initialized`

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized"
}
```

No response expected. Server is ready for tool calls after this.

## Supported Methods

| Method                      | Has `id` | Description                        |
| --------------------------- | -------- | ---------------------------------- |
| `initialize`                | Yes      | Protocol handshake                 |
| `notifications/initialized` | No       | Client ready signal                |
| `tools/list`                | Yes      | Returns available tool descriptors |
| `tools/call`                | Yes      | Invokes a tool by name             |

## Tool Descriptors（工具描述符）

Returned by `tools/list`:

### omm_state_read

```json
{
  "name": "omm_state_read",
  "description": "Read a JSON state file by key",
  "inputSchema": {
    "type": "object",
    "properties": { "key": { "type": "string" } },
    "required": ["key"]
  }
}
```

### omm_state_write

```json
{
  "name": "omm_state_write",
  "description": "Write a JSON value to a state file by key",
  "inputSchema": {
    "type": "object",
    "properties": {
      "key": { "type": "string" },
      "value": { "type": "object" }
    },
    "required": ["key", "value"]
  }
}
```

### omm_state_list

```json
{
  "name": "omm_state_list",
  "description": "List all state keys",
  "inputSchema": { "type": "object", "properties": {} }
}
```

## Tool Call Request / Response

### Request

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "omm_state_write",
    "arguments": {
      "key": "ralph",
      "value": { "mode": "ralph", "active": true, "status": "init" }
    }
  }
}
```

### Success Response

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Written: /home/user/.openclaw/omm/state/ralph.json"
      }
    ]
  }
}
```

### Error Response

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "error": {
    "code": -32000,
    "message": "terminal status requires active=false"
  }
}
```

## Error Codes

| Code     | Meaning              | When                                         |
| -------- | -------------------- | -------------------------------------------- |
| `-32700` | Parse error          | Invalid JSON received on stdin               |
| `-32601` | Method not found     | Unknown JSON-RPC method or unknown tool name |
| `-32000` | Tool execution error | Validation failure or file I/O error         |
| `-32603` | Internal error       | Unhandled exception in request handler       |

## Configuration

| Mechanism            | Variable         | Default           |
| -------------------- | ---------------- | ----------------- |
| Environment variable | `OMM_STATE_ROOT` | `~/.openclaw/omm` |

State files are stored at `{OMM_STATE_ROOT}/state/{key}.json`.

## Limitations

- **Tools only**: no resources, prompts, or sampling support
- **No streaming**: responses are single JSON objects
- **No authentication**: trusts any stdio client
- **Simplified validation**: phase + terminal checks only; no counter validation or default injection (see [State Contract](state-contract.md) for the full validation in the plugin)
