#!/bin/bash
set -euo pipefail

# nous CLI Installation Script
# Installs nous globally for production use

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${SCRIPT_DIR}"
PACKAGE_DIR="${REPO_DIR}/packages/opencode"
INSTALL_DIR="${HOME}/.noussh"
BIN_DIR="${INSTALL_DIR}/bin"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    if ! command -v bun &> /dev/null; then
        error "bun is not installed. Please install it first:"
        error "  curl -fsSL https://bun.sh/install | bash"
        exit 1
    fi
    
    info "Found bun version: $(bun --version)"
}

# Build the project
build_project() {
    info "Building nous CLI..."
    cd "${PACKAGE_DIR}"
    
    # Install dependencies if needed
    if [[ ! -d "node_modules" ]]; then
        info "Installing dependencies..."
        bun install
    fi
    
    # Build
    bun run build
    
    if [[ $? -ne 0 ]]; then
        error "Build failed!"
        exit 1
    fi
    
    info "Build successful!"
}

# Install globally
install_global() {
    info "Installing nous globally..."
    
    # Create directories
    mkdir -p "${BIN_DIR}"
    
    # Create the global nous binary
    cat > "${BIN_DIR}/nous" << EOF
#!/bin/bash
set -euo pipefail

# nous global CLI
# Installed from: ${REPO_DIR}

NOUS_DIR="${PACKAGE_DIR}"
BINARY="\${NOUS_DIR}/bin/nous"

# Check if native binary exists (production)
if [[ -x "\${BINARY}" ]]; then
    # Check if it's the wrapper or actual binary
    if file "\${BINARY}" | grep -q "text"; then
        # It's the wrapper script, check for cached binary
        CACHED="\$(dirname \${BINARY})/.noussh"
        if [[ -f "\${CACHED}" ]]; then
            exec "\${CACHED}" "\$@"
        fi
    else
        # It's a real binary
        exec "\${BINARY}" "\$@"
    fi
fi

# Development fallback
cd "\${NOUS_DIR}"
exec bun run --conditions=browser src/index.ts "\$@"
EOF
    
    chmod +x "${BIN_DIR}/nous"
    
    # Add to PATH if not already there
    SHELL_RC=""
    if [[ -n "${ZSH_VERSION:-}" ]] || [[ "$(basename "$SHELL")" == "zsh" ]]; then
        SHELL_RC="${HOME}/.zshrc"
    elif [[ -n "${BASH_VERSION:-}" ]] || [[ "$(basename "$SHELL")" == "bash" ]]; then
        SHELL_RC="${HOME}/.bashrc"
    fi
    
    if [[ -n "${SHELL_RC}" ]]; then
        if ! grep -q "\.noussh/bin" "${SHELL_RC}" 2>/dev/null; then
            info "Adding ${BIN_DIR} to PATH in ${SHELL_RC}"
            echo "" >> "${SHELL_RC}"
            echo "# nous CLI" >> "${SHELL_RC}"
            echo 'export PATH="${HOME}/.noussh/bin:${PATH}"' >> "${SHELL_RC}"
            info "Please run: source ${SHELL_RC}"
        else
            info "PATH already configured in ${SHELL_RC}"
        fi
    fi
    
    # Also add to current session
    export PATH="${BIN_DIR}:${PATH}"
    
    info "nous installed to ${BIN_DIR}/nous"
    info "Run 'nous --version' to verify"
}

# Main installation
main() {
    info "Starting nous CLI installation..."
    info "Repository: ${REPO_DIR}"
    
    check_prerequisites
    
    # Ask if user wants to build
    if [[ -f "${PACKAGE_DIR}/bin/nous" ]] && file "${PACKAGE_DIR}/bin/nous" | grep -qv "text"; then
        info "Native binary already exists, skipping build."
    else
        read -p "Build nous from source? (y/N): " -n 1 -r
        echo
        if [[ \$REPLY =~ ^[Yy]$ ]]; then
            build_project
        else
            info "Skipping build. Will use development mode."
        fi
    fi
    
    install_global
    
    # Test installation
    info "Testing installation..."
    if command -v nous &> /dev/null; then
        info "nous is now available!"
        nous --version || warn "nous --version failed, but binary exists"
    else
        warn "nous command not found in current session"
        warn "Please run: source ~/.zshrc (or ~/.bashrc)"
    fi
}

main "$@"
