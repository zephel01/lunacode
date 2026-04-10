#!/usr/bin/env bun

/**
 * ツール実行フローのテスト
 * 実際にツール呼び出しが正しく実行されるかを確認
 */

import { ToolRegistry } from "./src/tools/ToolRegistry.js";
import * as path from "path";
import * as fs from "fs/promises";

async function main() {
  const testDir = "/tmp/lunacode-test";

  // テストディレクトリをクリーンアップして作成
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch {}
  await fs.mkdir(testDir, { recursive: true });

  console.log("🧪 LunaCode Tool Execution Test");
  console.log("─".repeat(60));
  console.log(`📁 Test directory: ${testDir}\n`);

  const registry = new ToolRegistry();

  // テスト1: write_file
  console.log("Test 1: write_file");
  const testFile = path.join(testDir, "test.js");
  const writeResult = await registry.executeTool("write_file", {
    path: testFile,
    content: `console.log("Hello from LunaCode!");\n`,
  });
  console.log(`  Result: ${writeResult.success ? "✅ Success" : "❌ Failed"}`);
  if (writeResult.success) {
    console.log(`  ${writeResult.output}`);
  } else {
    console.log(`  Error: ${writeResult.error}`);
  }

  // テスト2: read_file
  console.log("\nTest 2: read_file");
  const readResult = await registry.executeTool("read_file", {
    path: testFile,
  });
  console.log(`  Result: ${readResult.success ? "✅ Success" : "❌ Failed"}`);
  if (readResult.success) {
    console.log(`  Content:\n${readResult.output}`);
  } else {
    console.log(`  Error: ${readResult.error}`);
  }

  // テスト3: edit_file
  console.log("\nTest 3: edit_file");
  const editResult = await registry.executeTool("edit_file", {
    path: testFile,
    oldString: `console.log("Hello from LunaCode!");`,
    newString: `console.log("Hello from LunaCode - EDITED!");`,
  });
  console.log(`  Result: ${editResult.success ? "✅ Success" : "❌ Failed"}`);
  if (editResult.success) {
    console.log(`  ${editResult.output}`);
  } else {
    console.log(`  Error: ${editResult.error}`);
  }

  // テスト4: ファイルが実際に編集されたか確認
  console.log("\nTest 4: Verify edit");
  const verifyResult = await registry.executeTool("read_file", {
    path: testFile,
  });
  console.log(`  Result: ${verifyResult.success ? "✅ Success" : "❌ Failed"}`);
  if (verifyResult.success) {
    console.log(`  Content:\n${verifyResult.output}`);
  }

  // テスト5: glob
  console.log("\nTest 5: glob");
  const globResult = await registry.executeTool("glob", {
    pattern: "*.js",
    path: testDir,
  });
  console.log(`  Result: ${globResult.success ? "✅ Success" : "❌ Failed"}`);
  if (globResult.success) {
    console.log(`  Files found:\n${globResult.output}`);
  }

  // テスト6: bash
  console.log("\nTest 6: bash");
  const bashResult = await registry.executeTool("bash", {
    command: `cd ${testDir} && ls -la`,
  });
  console.log(`  Result: ${bashResult.success ? "✅ Success" : "❌ Failed"}`);
  if (bashResult.success) {
    console.log(`  Output:\n${bashResult.output}`);
  }

  console.log("\n" + "─".repeat(60));
  console.log("✅ Tool execution test completed!");
  console.log(`\n📌 Test directory: ${testDir}`);
  console.log("   (You can manually inspect the files if needed)");
}

main().catch(console.error);
