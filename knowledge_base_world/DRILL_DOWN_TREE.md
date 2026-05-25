# Drill-Down Tree

_Edit this file to describe your project's knowledge areas, their associated
documentation, and the code files to read for each._

Template:
- <Area Name>
  - <DOC.md> — <description>
    → Read: <path/to/code/files>

## Project Overview
- **ProjectPurpose.md** — What nous/opencode is: AI-powered terminal-first coding assistant with TUI, web, and desktop interfaces
  → Read: README.md, package.json, packages/opencode/package.json

## Packages
- **PackagesOverview.md** — Monorepo structure with 5 main packages
  → Read: package.json, pnpm-workspace.yaml

### opencode (CLI/TUI)
- **OpenCodeCLI.md** — Main CLI entry point, commands (run, generate, agent, pr, session, mcp), TUI interface
  → Read: packages/opencode/package.json, packages/opencode/src/index.ts, packages/opencode/src/cli.ts

### core
- **CoreEngine.md** — Shared engine: auth, providers, permissions, git, tools
  → Read: packages/core/package.json, packages/core/src/index.ts

### app
- **WebApp.md** — Web UI built with SolidJS + Vite
  → Read: packages/app/package.json, packages/app/src/index.tsx

### desktop
- **DesktopApp.md** — Desktop application package
  → Read: packages/desktop/package.json

### sdk
- **SDK.md** — JavaScript SDK for building with opencode
  → Read: packages/sdk/package.json, packages/sdk/src/index.ts

## Build System
- **BuildSystem.md** — pnpm workspaces, TypeScript, build scripts
  → Read: package.json, pnpm-workspace.yaml, tsconfig.json

## Agent Capabilities
- **AgentSkills.md** — Built-in skills/tools available to the agent (skill, write, read, bash, etc.)
  → Read: packages/core/src/skills/ or skill definitions
- **FileCreation.md** — Agent can create standalone files (HTML, CSS, JS, etc.) in the workspace root
  → Read: N/A (runtime behavior)