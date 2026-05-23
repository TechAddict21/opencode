# nous CLI - Quick Start

## Development Mode (No Build Required)

The fastest way to run nous right now:

```bash
# From the repo root
./run.sh --version
./run.sh --help

# Any nous command works
./run.sh --dev
./run.sh -s my-session
```

## Install Globally

```bash
# Install to ~/.noussh/bin and add to PATH
./run.sh --install

# Then use from anywhere
source ~/.zshrc  # or ~/.bashrc
nous --version
nous --help
```

## Build Native Binary (Production)

```bash
# Build the optimized native binary
./run.sh --build

# After build, run in production mode
./run.sh --prod --version
```

## Direct Bun Usage (Development)

```bash
cd packages/opencode
bun run --conditions=browser src/index.ts --version
```

## Options

| Option | Description |
|--------|-------------|
| `--dev, -d` | Force development mode |
| `--prod, -p` | Force production mode (requires build) |
| `--build` | Build native binary first |
| `--install` | Install globally to `~/.noussh/bin` |
| `--help, -h` | Show help |

## Data Locations

- Config: `~/.config/nous/`
- Data: `~/.local/share/nous/`
- Cache: `~/.cache/nous/`
- Project config: `.noussh/` in your project

## Note

The native binary build is optional. The development mode (via bun) is fully functional and recommended for daily use.
