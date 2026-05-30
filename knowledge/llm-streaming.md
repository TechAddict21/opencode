# LLM streaming & prompt-fill pitfalls

How to make a one-shot LLM call and capture text + tokens + timing, and a
String.replace pitfall that silently corrupts prompts.

## Consuming `llm.stream(...)`

`LLM.Service`'s `stream(request)` returns a `Stream<LLMEvent, LLMError>`. A typical
no-tools call:

```ts
llm.stream({
  agent, user, system: ["..."], small: true, tools: {},
  model, sessionID, retries: 0,
  messages: [{ role: "user", content: prompt }],
})
```

Events (`LLMEvent`, schema in `packages/llm/src/schema/events.ts`, guards under
`LLMEvent.is.*`):

- `text-delta` — `LLMEvent.is.textDelta(e)` → `e.text` (the streamed text chunk).
- `step-finish` / `finish` — `LLMEvent.is.stepFinish(e)` / `is.finish(e)` → `e.usage?: Usage`.
- also `step-start`, `tool-call`, `tool-result`, `tool-error`, `reasoning`, etc.

`Usage` fields (all optional numbers): `inputTokens`, `outputTokens`, `reasoningTokens`,
`cacheReadInputTokens`, `cacheWriteInputTokens`, `nonCachedInputTokens`, `totalTokens`.
`inputTokens` is inclusive of cache; `outputTokens` is inclusive of reasoning.

### Text only

```ts
const raw = yield* stream.pipe(
  Stream.filter(LLMEvent.is.textDelta), Stream.map(e => e.text), Stream.mkString,
  Effect.timeout("60 seconds"), Effect.catch(() => Effect.succeed("")),
)
```

### Text + tokens + timing (what the reviewer uses)

Consume the *whole* stream with `Stream.runForEach`, accumulating into closures:

```ts
const started = Date.now()
let text = ""; let usage: Usage | undefined; let error: string | undefined
yield* stream.pipe(
  Stream.runForEach((e) => Effect.sync(() => {
    if (LLMEvent.is.textDelta(e)) text += e.text
    else if (LLMEvent.is.stepFinish(e)) { if (e.usage) usage = e.usage }
    else if (LLMEvent.is.finish(e))     { if (e.usage) usage = e.usage }
  })),
  Effect.timeout(Duration.seconds(60)),
  Effect.catch((err) => Effect.sync(() => { error = String(err) })),  // never fail the caller
)
// text/usage/error populated; durationMs = Date.now() - started
```

`Stream.runForEach` and `Stream.mkString` are both terminal (no extra Scope needed).
`Effect.timeout(...)` fails with a TimeoutException that `Effect.catch` absorbs.

The processor turns usage into cost/tokens via `Session.getUsage({ model, usage })` —
use that if you need cost, not just raw token counts.

## Prompt-template fill pitfall (IMPORTANT)

`String.prototype.replace(search, replacement)` with a **string** replacement interprets
`$$`, `$&`, `` $` ``, `$'`, `$1`…`$9`, `$<name>` specially. Code diffs and user text
routinely contain `$1`, `$&`, `${...}` (bash, regex, shell, template literals), so the
string form silently corrupts the prompt the model sees.

Always pass a **function** replacement, which inserts the value literally:

```ts
template.replace("{diff}", () => diff)          // safe
template.replace("{diff}", diff)                // BUG: $-sequences mangled
```

## Key Files

- `packages/llm/src/schema/events.ts` — `LLMEvent` (constructors + `is` guards) and `Usage`.
- `packages/llm/src/tool-runtime.ts` — how steps/usage are emitted/accumulated.
- `packages/opencode/src/session/llm.ts` — `LLM.Service` wrapper used across sessions.
- `packages/opencode/src/session/processor.ts` — real example: handles `step-finish`, `Session.getUsage`, cost/token accounting.
