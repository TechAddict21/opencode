#!/bin/bash
set -euo pipefail

# =============================================================================
# nous CLI Knowledge Optimizer
# =============================================================================
# Usage: ./knowledge_optimizer.sh [TARGET_DIR] [--limit N] [--hours H]
#
# Scans a project directory for source files, then runs `nous run` queries
# to populate the knowledge base via the feeder/completer flow.
#
# Features:
#   - Auto-discovers ts/tsx/js/jsx/json/py files
#   - Processes files in directory-grouped batches (BATCH_SIZE) so each batch
#     maps to a single knowledge area
#   - Maintains state in internal_checks/knowledge_optimizer.json
#   - Tracks failures in internal_checks/failed.txt
#   - Respects --hours cooldown between re-processing
#   - Aborts after 5 consecutive failures
# =============================================================================

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default values
DEFAULT_LIMIT=100
DEFAULT_HOURS=720  # 30 days in hours
MAX_CONSECUTIVE_FAILURES=5
BATCH_SIZE=5

# Extensions to scan
EXTENSIONS=("ts" "tsx" "js" "jsx" "json" "py")

# Directories to exclude
EXCLUDE_DIRS=("node_modules" "dist" ".git" ".turbo" ".next" "build" "out" "coverage" ".husky" ".vscode" ".zed" "target" ".cargo" "tmp" "temp" "vendor" "__pycache__" ".pytest_cache" ".mypy_cache" "internal_checks")

# File patterns to exclude
EXCLUDE_PATTERNS=("*.min.js" "*.min.css" "*.d.ts" "*.map" "*.lock" "*.lockb")

# State tracking
TEMP_FILES=""

log() {
    echo -e "${GREEN}[knowledge_optimizer]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[knowledge_optimizer]${NC} $1"
}

error() {
    echo -e "${RED}[knowledge_optimizer]${NC} $1"
}

info() {
    echo -e "${BLUE}[knowledge_optimizer]${NC} $1"
}

progress() {
    echo -e "${CYAN}[knowledge_optimizer]${NC} $1"
}

# Calculate relative path from base to target
# Usage: relative_path "/base/dir" "/base/dir/sub/file.ts" -> "sub/file.ts"
relative_path() {
    local base="$1"
    local target="$2"

    # Ensure both paths are absolute and normalized
    base="$(cd "$base" && pwd)"
    target="$(cd "$(dirname "$target")" && pwd)/$(basename "$target")"

    # Remove base prefix
    if [[ "$target" == "$base"/* ]]; then
        echo "${target#$base/}"
    elif [[ "$target" == "$base" ]]; then
        echo "."
    else
        echo "$target"
    fi
}

# Parse arguments
parse_args() {
    TARGET_DIR=""
    LIMIT="$DEFAULT_LIMIT"
    HOURS="$DEFAULT_HOURS"

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --limit)
                if [[ $# -lt 2 ]]; then
                    error "--limit requires a value"
                    exit 1
                fi
                LIMIT="$2"
                shift 2
                ;;
            --hours)
                if [[ $# -lt 2 ]]; then
                    error "--hours requires a value"
                    exit 1
                fi
                HOURS="$2"
                shift 2
                ;;
            --help|-h)
                print_help
                exit 0
                ;;
            --*)
                error "Unknown option: $1"
                exit 1
                ;;
            *)
                if [[ -z "$TARGET_DIR" ]]; then
                    TARGET_DIR="$1"
                else
                    error "Unexpected argument: $1"
                    exit 1
                fi
                shift
                ;;
        esac
    done
}

print_help() {
    cat << 'EOF'
nous Knowledge Optimizer

Usage: ./knowledge_optimizer.sh [TARGET_DIR] [OPTIONS]

Arguments:
    TARGET_DIR      Target project directory (optional, will prompt if missing)

Options:
    --limit N       Maximum files to process per run (default: 100)
    --hours H       Minimum hours since last processing before re-processing
                    (default: 720 = 30 days)
    --help, -h      Show this help message

Examples:
    ./knowledge_optimizer.sh /path/to/project
    ./knowledge_optimizer.sh /path/to/project --limit 90
    ./knowledge_optimizer.sh /path/to/project --limit 90 --hours 48
    ./knowledge_optimizer.sh --limit 90                    # Interactive dir prompt

Files created in TARGET_DIR:
    internal_checks/knowledge_optimizer.json   Processing state
    internal_checks/failed.txt                 Failure log

Notes:
    - Files are grouped by directory, then processed in batches of BATCH_SIZE
      (a batch never spans two directories, so each maps to one knowledge area)
    - Each batch runs: nous run "what is the use of "file1", "file2", ..."
EOF
}

# Prompt for target directory if not provided
prompt_target_dir() {
    if [[ -z "$TARGET_DIR" ]]; then
        echo -n "Enter target project directory: "
        read -r TARGET_DIR
    fi

    if [[ -z "$TARGET_DIR" ]]; then
        error "No target directory provided"
        exit 1
    fi

    # Resolve to absolute path
    if [[ ! "$TARGET_DIR" = /* ]]; then
        TARGET_DIR="$(pwd)/$TARGET_DIR"
    fi

    if [[ ! -d "$TARGET_DIR" ]]; then
        error "Directory does not exist: $TARGET_DIR"
        exit 1
    fi

    TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"
    log "Target directory: $TARGET_DIR"
}

# Validate numeric arguments
validate_args() {
    if ! [[ "$LIMIT" =~ ^[0-9]+$ ]] || [[ "$LIMIT" -lt 1 ]]; then
        error "--limit must be a positive integer"
        exit 1
    fi

    if ! [[ "$HOURS" =~ ^[0-9]+$ ]] || [[ "$HOURS" -lt 0 ]]; then
        error "--hours must be a non-negative integer"
        exit 1
    fi
}

# Check nous is available
check_nous() {
    if ! command -v nous &> /dev/null; then
        error "nous command not found in PATH"
        error "Install nous or ensure it's available: https://github.com/anomalyco/opencode"
        exit 1
    fi
    log "nous CLI found: $(which nous)"
}

# Create internal_checks directory
init_directories() {
    INTERNAL_CHECKS_DIR="$TARGET_DIR/internal_checks"
    mkdir -p "$INTERNAL_CHECKS_DIR"
    STATE_FILE="$INTERNAL_CHECKS_DIR/knowledge_optimizer.json"
    FAILED_FILE="$INTERNAL_CHECKS_DIR/failed.txt"
}

# Read or initialize state JSON
init_state() {
    if [[ -f "$STATE_FILE" ]]; then
        # Validate JSON
        if ! jq empty "$STATE_FILE" 2>/dev/null; then
            warn "Corrupted state file, reinitializing"
            create_empty_state
        fi
    else
        create_empty_state
    fi
}

create_empty_state() {
    cat > "$STATE_FILE" << 'EOF'
{
  "last_run": null,
  "files": {}
}
EOF
    log "Created new state file: $STATE_FILE"
}

# Build find command with extensions and exclusions
# Uses -prune for directory exclusions to avoid matching partial paths
build_find_command() {
    local cmd="find \"$TARGET_DIR\""

    # Exclude directories using -prune (proper way to skip directory trees)
    local prune_expr=""
    for dir in "${EXCLUDE_DIRS[@]}"; do
        if [[ -z "$prune_expr" ]]; then
            prune_expr="-type d -name \"$dir\""
        else
            prune_expr="$prune_expr -o -type d -name \"$dir\""
        fi
    done

    if [[ -n "$prune_expr" ]]; then
        cmd="$cmd \\( $prune_expr \\) -prune -o"
    fi

    # Match files with extensions
    cmd="$cmd -type f \\("
    local first=true
    for ext in "${EXTENSIONS[@]}"; do
        if [[ "$first" == true ]]; then
            first=false
        else
            cmd="$cmd -o"
        fi
        cmd="$cmd -name \"*.$ext\""
    done
    cmd="$cmd \\)"

    # Exclude file patterns
    for pattern in "${EXCLUDE_PATTERNS[@]}"; do
        cmd="$cmd ! -name \"$pattern\""
    done

    # Print matching files
    cmd="$cmd -print"

    echo "$cmd"
}

# Discover files
discover_files() {
    local find_cmd
    find_cmd="$(build_find_command)"

    # Create temp file for results
    TEMP_FILES=$(mktemp)
    eval "$find_cmd" > "$TEMP_FILES" 2>/dev/null

    local total_count
    total_count=$(wc -l < "$TEMP_FILES" | tr -d ' ')
    log "Found $total_count source files"

    if [[ "$total_count" -eq 0 ]]; then
        warn "No source files found in $TARGET_DIR"
        rm -f "$TEMP_FILES"
        exit 0
    fi
}

# Select files to process
# Priority:
# 1. Never processed (not in JSON)
# 2. Oldest processed (smallest last_processed timestamp)
# 3. Newest files by mtime (fallback)
select_files() {
    log "Selecting up to $LIMIT files for processing..."

    local now_epoch
    now_epoch=$(date +%s)
    local cutoff_epoch=$((now_epoch - HOURS * 3600))

    local selected_file
    selected_file=$(mktemp)

    while IFS= read -r file; do
        local rel_path
        rel_path="$(relative_path "$TARGET_DIR" "$file")"

        # Skip if we couldn't get a relative path
        if [[ "$rel_path" == /* ]]; then
            continue
        fi

        # Check if file is in state
        local last_processed
        last_processed=$(jq -r --arg path "$rel_path" '.files[$path].last_processed // empty' "$STATE_FILE" 2>/dev/null)

        if [[ -z "$last_processed" ]]; then
            # Never processed - highest priority
            local mtime_epoch
            mtime_epoch=$(stat -f %m "$file" 2>/dev/null || stat -c %Y "$file" 2>/dev/null)
            echo "0|$mtime_epoch|$rel_path" >> "$selected_file"
        else
            # Check if older than hours threshold
            local processed_epoch
            # Use Python for cross-platform UTC timestamp parsing
            processed_epoch=$(python3 -c "import datetime; print(int(datetime.datetime.fromisoformat('$last_processed'.replace('Z', '+00:00')).timestamp()))" 2>/dev/null || \
                             python -c "import datetime; print(int(datetime.datetime.strptime('$last_processed', '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc).timestamp()))" 2>/dev/null || \
                             date -j -f "%Y-%m-%dT%H:%M:%SZ" "$last_processed" +%s 2>/dev/null || \
                             date -d "$last_processed" +%s 2>/dev/null)

            if [[ -n "$processed_epoch" && "$processed_epoch" -lt "$cutoff_epoch" ]]; then
                # Can be reprocessed - sort by oldest first
                local mtime_epoch
                mtime_epoch=$(stat -f %m "$file" 2>/dev/null || stat -c %Y "$file" 2>/dev/null)
                echo "1|$processed_epoch|$rel_path" >> "$selected_file"
            fi
        fi
    done < "$TEMP_FILES"

    # Group selected files by DIRECTORY so each batch maps to one knowledge area
    # (the completer captures one area per run, so a batch of unrelated files
    # produces an incoherent area). Files in a dir stay contiguous; dirs are
    # ordered by their best (lowest priority/epoch) file so never-processed code
    # is still picked up first.
    # Input rows: priority|epoch|path. Output rows (sorted):
    #   dirMinPriority|dirMinEpoch|dir|priority|epoch|path
    local grouped_file
    grouped_file=$(mktemp)
    awk -F'|' '
        {
            pri=$1; ep=$2; rel=$3
            dir=rel; sub(/\/[^\/]*$/, "", dir); if (dir==rel) dir="."
            cand=sprintf("%d|%015d", pri, ep)
            if (dmin[dir]=="" || cand<dmin[dir]) dmin[dir]=cand
            n++; R[n]=dir "|" pri "|" ep "|" rel
        }
        END { for (i=1;i<=n;i++) { split(R[i],a,"|"); print dmin[a[1]] "|" R[i] } }
    ' "$selected_file" | sort -t'|' -k1,1n -k2,2n -k3,3 -k4,4n -k5,5n > "$grouped_file"

    local selected_count=0
    SELECTED_FILES=()
    while IFS='|' read -r _ _ _ _ _ filepath; do
        if [[ -n "$filepath" && $selected_count -lt $LIMIT ]]; then
            SELECTED_FILES+=("$filepath")
            selected_count=$((selected_count + 1))
        fi
    done < "$grouped_file"

    log "Selected $selected_count files for processing"

    rm -f "$selected_file" "$grouped_file"
}

# Update state with success for multiple files
mark_success_batch() {
    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Build jq filter for updating multiple files
    local filter="."
    for file_path in "$@"; do
        filter="$filter | .files[\"$file_path\"] = {\"last_processed\": \"$now\", \"status\": \"success\"}"
    done

    jq "$filter" "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
}

# Record failure for multiple files
record_failure_batch() {
    local error_msg="$1"
    shift
    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    for file_path in "$@"; do
        echo "[$now] $file_path: $error_msg" >> "$FAILED_FILE"
    done
}

# Process a batch of files
process_batch() {
    local current_batch="$1"
    local total_batches="$2"
    shift 2
    local batch_files=("$@")

    # Build the prompt with quoted filenames
    local prompt='what is the use of '
    local first=true
    for file in "${batch_files[@]}"; do
        if [[ "$first" == true ]]; then
            first=false
        else
            prompt="$prompt, "
        fi
        prompt="$prompt\"$file\""
    done

    progress "[$current_batch/$total_batches] Processing batch: ${batch_files[*]}"

    # Change to target directory and run nous
    local output
    local exit_code=0

    set +e
    output=$(cd "$TARGET_DIR" && nous run "$prompt" 2>&1)
    exit_code=$?
    set -e

    if [[ $exit_code -eq 0 ]]; then
        log "[$current_batch/$total_batches] Success: ${#batch_files[@]} files"
        mark_success_batch "${batch_files[@]}"
        return 0
    else
        error "[$current_batch/$total_batches] Failed batch (exit code: $exit_code)"
        record_failure_batch "Exit code $exit_code" "${batch_files[@]}"
        # Output last 3 lines for debugging
        local last_lines
        last_lines=$(echo "$output" | tail -n 3)
        if [[ -n "$last_lines" ]]; then
            error "Last output:"
            echo "$last_lines" | while IFS= read -r line; do
                error "  $line"
            done
        fi
        return 1
    fi
}

# Main processing loop
run_loop() {
    local total=${#SELECTED_FILES[@]}

    if [[ $total -eq 0 ]]; then
        log "No files need processing (all within $HOURS hours window)"
        return 0
    fi

    # Calculate number of batches
    local total_batches=$(((total + BATCH_SIZE - 1) / BATCH_SIZE))

    log "Starting processing loop (limit: $LIMIT, batch size: $BATCH_SIZE, batches: $total_batches, cooldown: ${HOURS}h)"
    echo ""

    local consecutive_failures=0
    local success_count=0
    local fail_count=0
    local batch_idx=0

    local i=0
    while [[ $i -lt $total ]]; do
        batch_idx=$((batch_idx + 1))

        # Build batch array. A batch never spans two directories — same-dir files
        # are contiguous (see select_files), so breaking on a dirname change keeps
        # each batch within one area, matching the completer's one-area-per-run.
        local batch=()
        local j=0
        local batch_dir=""
        while [[ $j -lt $BATCH_SIZE && $i -lt $total ]]; do
            local f="${SELECTED_FILES[$i]}"
            local fdir
            fdir="$(dirname "$f")"
            if [[ $j -gt 0 && "$fdir" != "$batch_dir" ]]; then
                break
            fi
            batch_dir="$fdir"
            batch+=("$f")
            i=$((i + 1))
            j=$((j + 1))
        done

        if process_batch "$batch_idx" "$total_batches" "${batch[@]}"; then
            success_count=$((success_count + ${#batch[@]}))
            consecutive_failures=0
        else
            fail_count=$((fail_count + ${#batch[@]}))
            consecutive_failures=$((consecutive_failures + 1))

            if [[ $consecutive_failures -ge $MAX_CONSECUTIVE_FAILURES ]]; then
                error ""
                error "Aborting: $MAX_CONSECUTIVE_FAILURES consecutive failures reached"
                break
            fi
        fi

        # Small delay between batches to avoid overwhelming the system
        if [[ $i -lt $total ]]; then
            sleep 0.5
        fi
    done

    echo ""
    log "=== Summary ==="
    log "Total files: $total"
    log "Batches processed: $batch_idx / $total_batches"
    log "Successful: $success_count"
    log "Failed: $fail_count"

    if [[ -f "$FAILED_FILE" ]]; then
        local failed_total
        failed_total=$(wc -l < "$FAILED_FILE" | tr -d ' ')
        log "Total failures recorded: $failed_total"
    fi
}

# Update last_run timestamp
update_last_run() {
    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    jq --arg time "$now" '.last_run = $time' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
}

# Cleanup
cleanup() {
    if [[ -n "${TEMP_FILES:-}" && -f "$TEMP_FILES" ]]; then
        rm -f "$TEMP_FILES"
    fi
}

# Main entry
main() {
    trap cleanup EXIT

    parse_args "$@"
    prompt_target_dir
    validate_args
    check_nous
    init_directories
    init_state
    discover_files
    select_files
    run_loop
    update_last_run

    log "Done! State saved to: $STATE_FILE"
}

main "$@"
