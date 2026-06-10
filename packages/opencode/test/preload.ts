// Minimal test preload (referenced by bunfig.toml [test].preload): isolate the
// XDG dirs so any test that touches storage/logs never writes to the real user
// directories. Must run BEFORE any src/ import — xdg-basedir reads env at
// import time.
import os from "os"
import path from "path"
import fs from "fs/promises"

const dir = path.join(os.tmpdir(), "opencode-test-data-" + process.pid)
await fs.mkdir(dir, { recursive: true })
process.env["XDG_DATA_HOME"] = path.join(dir, "share")
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
process.env["XDG_STATE_HOME"] = path.join(dir, "state")
