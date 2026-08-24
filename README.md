# nest_js_claude_api_example

An example of integrating with the [Anthropic](https://www.anthropic.com) Messages API
using [NestJS](https://nestjs.com), built as a practical sandbox for applying knowledge
gained through Claude Certified Architect — Foundations. It starts from the basics —
typed endpoints, DTO validation, meaningful HTTP error mapping, SSE streaming — and is
meant to grow with more integration use cases over time.

## Setup

Set the key in the environment before starting the app — it is never read
from a file or committed to the repository:

```bash
export ANTHROPIC_API_KEY="your_api_key"
npm install
npm run start:dev
```

The app refuses to start without `ANTHROPIC_API_KEY`. Five endpoints are
available.

### Single message

```bash
curl -X POST http://localhost:3000/claude/message \
  -H 'Content-Type: application/json' \
  -d '{"message":"Explain what NestJS is in two sentences"}'
```

You can also pass `model`, `maxTokens`, `system` and `temperature`.

### Conversation with history

```bash
curl -X POST http://localhost:3000/claude/conversation \
  -H 'Content-Type: application/json' \
  -d '{"messages":[
    {"role":"user","content":"What is dependency injection?"},
    {"role":"assistant","content":"A way to pass dependencies from outside."},
    {"role":"user","content":"Show a short example."}
  ]}'
```

### Streaming answer (SSE)

```bash
curl -N -X POST http://localhost:3000/claude/stream \
  -H 'Content-Type: application/json' \
  -d '{"message":"Write a haiku about streams"}'
```

The body is the same as for the conversation endpoint, but either a single
`message` or a full `messages` history may be supplied (not both). The reply is
`text/event-stream`; every frame is one JSON payload on a `data:` line:

```text
data: {"type":"message_start","id":"msg_...","model":"claude-haiku-4-5"}
data: {"type":"text_delta","text":"Hello "}
data: {"type":"text_delta","text":"world"}
data: {"type":"message_stop","stopReason":"end_turn","usage":{"inputTokens":10,"outputTokens":2}}
```

Concatenate successive `text_delta` payloads to assemble the answer as it is
generated. If a failure occurs mid-stream, a final
`{"type":"error","message":"..."}` frame is emitted; failures before the first
frame produce a regular HTTP error response instead.

### Raw streaming (unmodified Anthropic protocol)

The normalized stream above trades fidelity for convenience. `POST
/claude/raw-stream` accepts the same body but forwards the upstream protocol
unchanged — every event type, in the exact wire format the Anthropic API uses:

```bash
curl -N -X POST http://localhost:3000/claude/raw-stream \
  -H 'Content-Type: application/json' \
  -d '{"message":"Write a haiku about streams"}'
```

Each frame carries an `event:` line naming the type plus the untouched JSON
payload on a `data:` line:

```text
event: message_start
data: {"type":"message_start","message":{"id":"msg_...","model":"claude-haiku-4-5",...}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}

event: message_stop
data: {"type":"message_stop"}
```

The lifecycle: `message_start` opens the message and carries the initial usage
counters; each content block runs `content_block_start` → one or more
`content_block_delta` (delta types include `text_delta`, `input_json_delta`,
`thinking_delta`) → `content_block_stop`; `message_delta` delivers the final
stop reason and cumulative output tokens; `message_stop` closes the stream.
`ping` keepalives may appear anywhere. New event and delta types are added to
the protocol over time without version bumps, so consumers should ignore what
they do not recognize.

### List models

```bash
curl http://localhost:3000/claude/models
```

The message response contains `text`, the model, the stop reason and token usage.

Request bodies are validated: empty strings, unknown fields and wrong types
(for example, `temperature` outside the 0–1 range) are rejected with `400`.
Anthropic API failures are surfaced as meaningful HTTP codes: `429` on rate
limits, `503` when the configured key or connection is broken, `400` for
requests the API considers invalid (e.g. an unknown model) and `502` for any
other API error.

## Probing endpoints from IntelliJ IDEA

`requests.http` contains ready-to-run requests for all five endpoints
(including both streaming variants and a few invalid payloads that demonstrate
`400` responses). Open it in IntelliJ IDEA, start the app with `npm run start:dev`,
pick an environment in the selector above the editor and click the run icon
next to any request.

The environment variables live in `http-client.env.json`. If you ever need
personal overrides or tokens there, put them into
`http-client.private.env.json` — it is gitignored and takes precedence over
the public file.

SSE responses are rendered incrementally by the HTTP Client, so streamed
frames appear as they arrive.

## Testing

```bash
npm run lint       # eslint
npm run test       # unit tests
npm run test:e2e   # end-to-end tests over the real HTTP stack
```

## License

[MIT](LICENSE)
