# Skills: discovery & loading

How nous finds local skills (SKILL.md files) and why a skill can be "not found".

## Where skills are loaded from (`skill/index.ts` → `discoverSkills`)

1. **External dirs** (`.claude`, `.agents`), pattern `skills/**/SKILL.md`:
   - under `~` (global), and
   - by walking **up from the cwd to the worktree root** (project-local).
   - Gated by flags `disableExternalSkills` / `disableClaudeCodeSkills`.
2. **nous config dirs** (`config.directories()` → `ConfigPaths.directories` in `config/paths.ts`),
   pattern `{skill,skills}/**/SKILL.md`:
   - `~/.config/nous` (`Global.Path.config`),
   - `.noussh` found by walking **up from cwd → worktree** (project-local),
   - `~/.noussh` (home).
3. **`skills.paths`** in config — each dir scanned `**/SKILL.md` (absolute, or `~/…`, or relative to cwd).
4. **`skills.urls`** in config — remote skill packs pulled & cached (`skill/discovery.ts`).

A built-in `customize-nous` skill is always registered (can be overridden by a disk skill of the same name).

## The #1 "skill not found" cause

`.noussh/skills/<name>/SKILL.md` inside a **project repo** is only discovered when nous runs
**from inside that repo** (the `.noussh` walk is cwd→worktree). Running nous from an unrelated
directory (e.g. `~/test`) will not find it, and `~/.noussh` has **no** `skills/` dir by default.

**To make a skill globally available** (any cwd), do ONE of:
- put it at `~/.noussh/skills/<name>/SKILL.md` or `~/.config/nous/skills/<name>/SKILL.md`, or
- add its parent dir to `skills.paths` in `~/.config/nous/nous.jsonc`, e.g.
  `{"skills": {"paths": ["/abs/path/to/.noussh/skills"]}}` (scans `**/SKILL.md`, picks up all skills under it).

Config is read at runtime → **no rebuild needed** for `skills.paths` changes (unlike source edits).

## SKILL.md format

Frontmatter: `name` (required), `description` (optional but needed to surface the skill to the model).
The loader warns on duplicate `name`; there is a `NameMismatchError` for name-vs-directory mismatch,
so keep `name` matching the folder.

## Key Files

- `packages/opencode/src/skill/index.ts` — `discoverSkills`, `scan`, frontmatter parse, the `Skill` service (`get`/`require`/`all`/`available`).
- `packages/opencode/src/config/paths.ts` — `ConfigPaths.directories` (which `.noussh` / config dirs are scanned).
- `packages/opencode/src/skill/discovery.ts` — remote skill pull (`skills.urls`).
- `packages/opencode/src/config/config.ts` — `skills` config (`paths`, `urls`).
