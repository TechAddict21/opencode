#!/bin/bash
set -euo pipefail

# =============================================================================
# nous CLI Runner - Production & Development
# =============================================================================
# Usage: ./run.sh [nous-args...]
# 
# This script runs nous in the most appropriate mode:
# 1. Production: Uses native binary if available (via packages/opencode/bin/nous)
# 2. Development: Runs directly via bun
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${SCRIPT_DIR}"
PACKAGE_DIR="${REPO_DIR}/packages/opencode"
BIN_WRAPPER="${PACKAGE_DIR}/bin/nous"
NATIVE_BINARY=""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
    echo -e "${GREEN}[nous]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[nous]${NC} $1"
}

error() {
    echo -e "${RED}[nous]${NC} $1"
}

info() {
    echo -e "${BLUE}[nous]${NC} $1"
}

# Find native binary (platform-specific)
find_native_binary() {
    local platform arch
    
    case "$(uname -s)" in
        Darwin) platform="darwin" ;;
        Linux) platform="linux" ;;
        CYGWIN*|MINGW*|MSYS*) platform="windows" ;;
        *) platform="$(uname -s | tr '[:upper:]' '[:lower:]')" ;;
    esac
    
    case "$(uname -m)" in
        x86_64|amd64) arch="x64" ;;
        arm64|aarch64) arch="arm64" ;;
        armv7l) arch="arm" ;;
        *) arch="$(uname -m)" ;;
    esac
    
    # Check common locations for native binary
    local candidates=(
        "${REPO_DIR}/.noussh"
        "${PACKAGE_DIR}/.noussh"
        "${PACKAGE_DIR}/dist/opencode-${platform}-${arch}/bin/opencode"
        "${REPO_DIR}/node_modules/opencode-${platform}-${arch}/bin/nous"
        "${REPO_DIR}/node_modules/opencode-${platform}-${arch}/bin/nous.exe"
    )
    
    for candidate in "${candidates[@]}"; do
        if [[ -x "${candidate}" ]] && [[ ! -d "${candidate}" ]]; then
            NATIVE_BINARY="${candidate}"
            return 0
        fi
    done
    
    return 1
}

# Run in production mode (native binary)
run_production() {
    if [[ -n "${NATIVE_BINARY}" ]]; then
        log "Running native binary: ${NATIVE_BINARY}"
        exec "${NATIVE_BINARY}" "$@"
    fi
    
    # Check if wrapper has a native binary to run
    local cached="$(dirname "${BIN_WRAPPER}")/.noussh"
    if [[ -x "${BIN_WRAPPER}" ]] && [[ -f "${cached}" ]] && [[ ! -d "${cached}" ]]; then
        log "Running via binary wrapper"
        exec "${BIN_WRAPPER}" "$@"
    fi
    
    return 1
}

# Run in development mode (via bun)
run_development() {
    if ! command -v bun &> /dev/null; then
        error "bun is not installed."
        error "Install it: curl -fsSL https://bun.sh/install | bash"
        exit 1
    fi
    
    info "Running in development mode via bun..."
    cd "${PACKAGE_DIR}"
    
    # Check if we need to install dependencies
    if [[ ! -d "node_modules" ]]; then
        warn "node_modules not found, running bun install..."
        bun install
    fi
    
    exec bun run --conditions=browser src/index.ts "$@"
}

# Print help
print_help() {
    cat << 'EOF'
nous CLI Runner

Usage: ./run.sh [OPTIONS] [NOUS_ARGS...]

Options:
    --help, -h      Show this help message
    --dev, -d       Force development mode (via bun)
    --prod, -p      Force production mode (native binary)
    --build         Build native binary first
    --install       Install nous globally to ~/.noussh/bin

Examples:
    ./run.sh --version              Run nous --version
    ./run.sh --dev                  Force development mode
    ./run.sh --build                Build then run
    ./run.sh --install              Install globally

For more information: https://github.com/anomalyco/opencode
EOF
}

# Build native binary
build_binary() {
    if ! command -v bun &> /dev/null; then
        error "bun is required for building"
        exit 1
    fi
    
    log "Building native binary..."
    cd "${PACKAGE_DIR}"
    
    if [[ ! -d "node_modules" ]]; then
        bun install
    fi
    
    bun run build
    
    if [[ $? -eq 0 ]]; then
        log "Build successful!"
    else
        error "Build failed!"
        exit 1
    fi
}

# Install globally
install_global() {
    local install_dir="${HOME}/.noussh"
    local bin_dir="${install_dir}/bin"
    
    log "Installing nous globally..."
    mkdir -p "${bin_dir}"
    
    # Create wrapper script
    cat > "${bin_dir}/nous" << EOF
#!/bin/bash
set -euo pipefail
# nous global CLI - auto-generated
exec "${REPO_DIR}/run.sh" "\$@"
EOF
    
    chmod +x "${bin_dir}/nous"
    
    # Add to PATH
    local shell_rc=""
    if [[ -n "${ZSH_VERSION:-}" ]] || [[ "$(basename "$SHELL")" == "zsh" ]]; then
        shell_rc="${HOME}/.zshrc"
    elif [[ -n "${BASH_VERSION:-}" ]] || [[ "$(basename "$SHELL")" == "bash" ]]; then
        shell_rc="${HOME}/.bashrc"
    fi
    
    if [[ -n "${shell_rc}" ]] && ! grep -q "\.noussh/bin" "${shell_rc}" 2>/dev/null; then
        echo "" >> "${shell_rc}"
        echo "# nous CLI" >> "${shell_rc}"
        echo 'export PATH="${HOME}/.noussh/bin:${PATH}"' >> "${shell_rc}"
        log "Added to PATH in ${shell_rc}"
        log "Run: source ${shell_rc}"
    fi
    
    # Add to current session
    export PATH="${bin_dir}:${PATH}"
    
    log "nous installed to ${bin_dir}/nous"
    log "Run 'nous --version' to verify"
}

# Main
main() {
    local force_dev=false
    local force_prod=false
    local should_build=false
    local should_install=false
    local nous_args=()
    
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --help|-h)
                print_help
                exit 0
                ;;
            --dev|-d)
                force_dev=true
                shift
                ;;
            --prod|-p)
                force_prod=true
                shift
                ;;
            --build)
                should_build=true
                shift
                ;;
            --install)
                should_install=true
                shift
                ;;
            *)
                nous_args+=("$1")
                shift
                ;;
        esac
    done
    
    # Handle install
    if [[ "${should_install}" == true ]]; then
        install_global
        exit 0
    fi
    
    # Handle build
    if [[ "${should_build}" == true ]]; then
        build_binary
        # Continue to run after build
    fi
    
    # Determine mode
    if [[ "${force_dev}" == true ]]; then
        run_development "${nous_args[@]:-}"
    elif [[ "${force_prod}" == true ]]; then
        find_native_binary || true
        if ! run_production "${nous_args[@]:-}"; then
            error "Production binary not found. Build with: ./run.sh --build"
            exit 1
        fi
    else
        # Auto-detect: prefer production, fallback to development
        find_native_binary || true
        if ! run_production "${nous_args[@]:-}"; then
            warn "No native binary found, using development mode..."
            run_development "${nous_args[@]:-}"
        fi
    fi
}

main "$@"
