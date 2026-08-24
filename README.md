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

The app refuses to start without `ANTHROPIC_API_KEY`. Four endpoints are
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

## Testing

```bash
npm run lint       # eslint
npm run test       # unit tests
npm run test:e2e   # end-to-end tests over the real HTTP stack
```

## License

[MIT](LICENSE)
