# Code Reviewer

The code reviewer is an LLM-driven subsystem that reviews code changes during a session. It is invoked from the session prompt and can perform multi-round review/fix iterations. It supports a "curl testing" lens mode that is triggered when API/HTTP-related files change and the `curl_testing` config flag is set. Before the curl lens runs, the code now checks for `run.sh` in the project directory and executes `./run.sh --build` if present — failures are warned but do not block the review.

Process spawning (`ChildProcessSpawner`) is the standard way to run external commands (shell commands, git, process discovery) across the codebase. The spawner is yielded as a dependency in Effect layers.

## Key Files
- `packages/opencode/src/reviewer/code-reviewer.ts` — main code review service: runs LLM review, optionally executes `run.sh --build`, orchestrates curl testing lens
- `packages/opencode/src/session/prompt.ts` — session prompt that invokes the code reviewer with the project directory and user request
- `packages/opencode/src/tool/shell.ts` — shell command execution tool using `ChildProcessSpawner`
- `packages/opencode/src/project/project.ts` — project service that uses `ChildProcessSpawner` for git operations
- `packages/opencode/src/mcp/index.ts` — MCP server using `ChildProcessSpawner` for child-process tree discovery via `pgrep`

## Notes
- The `run.sh` execution was added programmatically in `packages/opencode/src/reviewer/code-reviewer.ts` (not in the curl prompt) — it runs `./run.sh --build` from `input.directory` and only logs a warning on failure.
- `ChildProcessSpawner` is the standard spawn abstraction across the project, obtained via `yield* ChildProcessSpawner` in effectful layers.