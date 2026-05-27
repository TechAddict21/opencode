#!/usr/bin/env bun

import fs from "fs"
import path from "path"
import os from "os"
import { fileURLToPath } from "url"
import { $ } from "bun"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const pkgDir = path.resolve(__dirname, "..")

const noAuth = process.argv.includes("--no-auth")

const platformMap: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" }
const archMap: Record<string, string> = { x64: "x64", arm64: "arm64", arm: "arm" }

const platform = platformMap[os.platform()] ?? os.platform()
const arch = archMap[os.arch()] ?? os.arch()

function supportsAvx2(): boolean {
  if (arch !== "x64") return false

  if (platform === "darwin") {
    try {
      const result = Bun.spawnSync(["sysctl", "-n", "hw.optional.avx2_0"], { timeout: 1500 })
      if (result.exitCode !== 0) return false
      return new TextDecoder().decode(result.stdout).trim() === "1"
    } catch {
      return false
    }
  }

  if (platform === "linux") {
    try {
      return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
    } catch {
      return false
    }
  }

  return false
}

const avx2 = supportsAvx2()
const baseline = arch === "x64" && !avx2

let binaryName = `opencode-${platform}-${arch}`
if (baseline) binaryName += "-baseline"

if (platform === "linux") {
  try {
    const result = Bun.spawnSync(["ldd", "--version"])
    const text = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)
    if (text.toLowerCase().includes("musl")) {
      binaryName = baseline
        ? `opencode-${platform}-${arch}-baseline-musl`
        : `opencode-${platform}-${arch}-musl`
    }
  } catch {
    // ignore
  }
}

const binaryPath = path.join(pkgDir, "dist", binaryName, "bin", "opencode")

if (!fs.existsSync(binaryPath)) {
  console.error(`Binary not found: ${binaryPath}`)
  console.error("Run 'bun run build --single' first to build for your platform.")
  process.exit(1)
}

const home = os.homedir()
const globalConfigDir = path.join(home, ".config", "nous")
const globalDataDir = path.join(home, ".local", "share", "nous")
const repoNousshDir = path.resolve(pkgDir, "..", "..", ".noussh")

const bundleDir = path.join(pkgDir, "dist", "nous-share")
const bundleBinDir = path.join(bundleDir, "bin")
const bundleConfigDir = path.join(bundleDir, "config")
const bundleDataDir = path.join(bundleDir, "data", "nous")

if (fs.existsSync(bundleDir)) {
  await fs.promises.rm(bundleDir, { recursive: true })
}

await fs.promises.mkdir(bundleBinDir, { recursive: true })
await fs.promises.mkdir(bundleConfigDir, { recursive: true })
await fs.promises.mkdir(bundleDataDir, { recursive: true })

const wrapperSrc = path.join(pkgDir, "bin", "nous")
await fs.promises.copyFile(binaryPath, path.join(bundleBinDir, "opencode"))
await fs.promises.chmod(path.join(bundleBinDir, "opencode"), 0o755)
await fs.promises.copyFile(wrapperSrc, path.join(bundleBinDir, "nous"))
await fs.promises.chmod(path.join(bundleBinDir, "nous"), 0o755)

async function cpRecursive(src: string, dest: string) {
  const stat = await fs.promises.stat(src)
  if (stat.isDirectory()) {
    await fs.promises.mkdir(dest, { recursive: true })
    const entries = await fs.promises.readdir(src, { withFileTypes: true })
    for (const entry of entries) {
      await cpRecursive(path.join(src, entry.name), path.join(dest, entry.name))
    }
  } else {
    await fs.promises.copyFile(src, dest)
  }
}

if (fs.existsSync(globalConfigDir)) {
  const entries = await fs.promises.readdir(globalConfigDir, { withFileTypes: true })
  for (const entry of entries) {
    await cpRecursive(path.join(globalConfigDir, entry.name), path.join(bundleConfigDir, entry.name))
  }
}

if (fs.existsSync(repoNousshDir)) {
  const skip = new Set([
    "node_modules",
    "plans",
    "package.json",
    "bun.lock",
    ".gitignore",
    "package-lock.json",
    "references",
    "env.d.ts",
  ])

  const entries = await fs.promises.readdir(repoNousshDir, { withFileTypes: true })

  for (const entry of entries) {
    if (skip.has(entry.name)) continue

    const src = path.join(repoNousshDir, entry.name)

    if (entry.name === "opencode.jsonc") {
      await fs.promises.copyFile(src, path.join(bundleConfigDir, "nous.jsonc"))
    } else {
      const destName =
        entry.name === "agent"
          ? "agents"
          : entry.name === "command"
            ? "commands"
            : entry.name === "tool"
              ? "tools"
              : entry.name

      await cpRecursive(src, path.join(bundleConfigDir, destName))
    }
  }
}

const authSrc = path.join(globalDataDir, "auth.json")
if (noAuth) {
  console.log("Skipped auth.json (--no-auth passed)")
} else if (fs.existsSync(authSrc)) {
  await fs.promises.copyFile(authSrc, path.join(bundleDataDir, "auth.json"))
  console.log("Included auth.json (API keys)")
} else {
  console.warn("No auth.json found at ~/.local/share/nous/auth.json — bundle will not include API keys")
}

const readmePath = path.join(bundleDir, "README.txt")
const readmeContent = noAuth
  ? `Nous Shareable Bundle
=====================

This bundle includes the nous CLI with pre-configured settings.
NOTE: API keys were excluded (--no-auth).

To run:
  ./nous-share/bin/nous

Or extract and add to PATH:
  tar -xzf nous-share-*.tar.gz
  export PATH="$PWD/nous-share/bin:$PATH"
  nous
`
  : `Nous Shareable Bundle
=====================

This bundle includes the nous CLI with pre-configured settings and API keys.

To run:
  ./nous-share/bin/nous

Or extract and add to PATH:
  tar -xzf nous-share-*.tar.gz
  export PATH="$PWD/nous-share/bin:$PATH"
  nous
`
await fs.promises.writeFile(readmePath, readmeContent)

const archiveSuffix = platform === "windows" ? "zip" : "tar.gz"
const archiveName = `nous-share-${platform}-${arch}${baseline ? "-baseline" : ""}.${archiveSuffix}`
const archivePath = path.join(pkgDir, "dist", archiveName)

if (platform === "windows") {
  await $`zip -r ${archivePath} ${path.basename(bundleDir)}`.cwd(path.dirname(bundleDir))
} else {
  await $`tar -czf ${archivePath} -C ${path.dirname(bundleDir)} ${path.basename(bundleDir)}`
}

await fs.promises.rm(bundleDir, { recursive: true })

console.log(`Shareable bundle created: ${archivePath}`)
console.log(`Extract and run: tar -xzf ${archiveName} && ./nous-share/bin/nous`)
