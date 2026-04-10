#!/bin/bash
# LunaCode CLI Wrapper Script
# This script allows running lunacode from anywhere

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

# Check if we're in the LunaCode directory or if CLI exists
LUNACODE_CLI="$SCRIPT_DIR/src/cli.ts"

# If CLI doesn't exist in script dir, try to find it in current directory
if [ ! -f "$LUNACODE_CLI" ]; then
    # Check if we're already in the LunaCode directory
    if [ -f "./src/cli.ts" ]; then
        LUNACODE_CLI="./src/cli.ts"
    else
        echo "Error: LunaCode CLI not found"
        echo "Please run this script from the LunaCode directory or install globally"
        exit 1
    fi
fi

# Run the CLI with all passed arguments
bun run "$LUNACODE_CLI" "$@"
