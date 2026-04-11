#!/bin/bash
# テスト用セットアップスクリプト

TEST_DIR="/tmp/lunacode-tool-test"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"

cat > "$TEST_DIR/.kairos/config.json" << 'CONFIG'
{
  "llm": {
    "provider": "openai",
    "openai": {
      "apiKey": "test-key",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o-mini"
    }
  },
  "agent": {
    "maxIterations": 5
  }
}
CONFIG

echo "✅ Test setup complete in $TEST_DIR"
echo "Config file: $TEST_DIR/.kairos/config.json"
ls -la "$TEST_DIR/.kairos/"
