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

## Stall guard (processor `process`)

The main agent loop (`processor.ts` `process`) wraps the stream drain in a stall
guard so a degenerate generation — model emitting reasoning/no output, or a frozen
stream on a huge context — cannot hang for minutes. Mechanism:

- A `lastEventAt` timestamp is bumped in the drain's `Stream.tap` on every event.
- A watchdog fiber races the drain (`Effect.race(drain.as("ok"), watchdog)`). When
  no event arrives for `experimental.llm_stall_timeout_ms` (default 180 000), the
  watchdog returns and **race interrupts the drain**, which closes the `llm.stream`
  scope → fires the `acquireRelease` `ctrl.abort()` in `llm.ts` (same teardown as a
  user cancel). The processor then calls `halt(AbortError)`, so the turn ends with
  an error and the loop returns `"stop"` (no `Effect.retry` re-run of the stall).
- **Inline-tool caveat:** AI SDK tools have `execute` fns (`session/tools.ts`), so a
  tool runs *inside* the stream between its `tool-call` and `tool-result` events — a
  long bash/test/build is a legitimate multi-minute gap. The guard tracks an
  in-flight-tool counter and **skips the stall check while `toolsInFlight > 0`**, so
  it only measures model-generation silence. Optional hard ceiling:
  `experimental.llm_max_duration_ms` (0 = off).

`interruptWhen` was rejected here: it ends the stream as a *graceful success* (no
interrupt, no `onInterrupt`, no `finish` event), leaving a half-finished message.
The race-then-explicit-`halt` path reproduces the exact user-cancel terminal state.

## Global thinking kill-switch (`experimental.disable_thinking`, default ON)

Reasoning/thinking is enabled per provider in `ProviderTransform.options()` (the
**non-small** base), which injects keys like `thinking:{type:"enabled"}` for `k2p`
on the anthropic SDK, `enable_thinking`/`chat_template_args` for kimi/dashscope,
`reasoningEffort` for gpt-5, etc. `smallOptions()` omits all of these — which is
exactly why `small:true` calls (triage + every reviewer + fixer) run `reason=0`
and never think, while the main agent (`small:false`) does.

`request.ts` `prepare()` strips every one of those keys from the merged `options`
when `disableThinking` is set (threaded from `config.experimental.disable_thinking`
at llm.ts, default `true`). Disabling thinking is just the **absence** of the key —
no provider needs an explicit "off" (the reviewer path proves it: omit → no
reasoning, no error). This makes the main agent behave like the reviewers and kills
runaway reasoning (e.g. a 60K-char reasoning spiral that ate ~6 min on one turn).
Set `disable_thinking: false` to restore per-model thinking.

## Per-call analysis log

Every `llm.stream` call (main agent *and* reviewer subagents) writes paired
`<seq>_<ts>_request.json` / `_response.json` under `<data>/analysis/<sessionID>/`
when `experimental.api_analysis_log` (default true). The request captures the
assembled context (system + messages); the response captures outcome
(`ok`/`interrupted`/`error`), finishReason, usage, text/reasoning lengths, event
count, durationMs. This is the primary tool for diagnosing hangs — find the call
with the largest `durationMs` and inspect its outcome/event counts.

## Key Files

- `packages/llm/src/schema/events.ts` — `LLMEvent` (constructors + `is` guards) and `Usage`.
- `packages/llm/src/tool-runtime.ts` — how steps/usage are emitted/accumulated.
- `packages/opencode/src/session/llm.ts` — `LLM.Service` wrapper used across sessions.
- `packages/opencode/src/session/processor.ts` — real example: handles `step-finish`, `Session.getUsage`, cost/token accounting.
