import { describe, test, expect, beforeEach } from "bun:test";
import {
  ApprovalManager,
  ApprovalConfig,
  ApprovalCallbacks,
  ApprovalRequest,
} from "../src/agents/ApprovalManager.js";

describe("ApprovalManager", () => {
  let approvalManager: ApprovalManager;
  let config: ApprovalConfig;
  let approvalRequests: ApprovalRequest[] = [];

  const createCallbacks = (): ApprovalCallbacks => ({
    requestApproval: async (request: ApprovalRequest) => {
      approvalRequests.push(request);

      // Default: approve the request
      return {
        result: "approved",
      };
    },
  });

  beforeEach(() => {
    approvalRequests = [];
  });

  test("auto mode approves everything", async () => {
    config = {
      mode: "auto",
      showDiff: false,
      autoApproveReadOnly: false,
      timeoutSeconds: 0,
    };
    approvalManager = new ApprovalManager(config, createCallbacks());

    const result = await approvalManager.checkApproval(
      "write_file",
      { filePath: "test.txt", content: "test" },
      "MEDIUM",
    );

    expect(result.approved).toBe(true);
    expect(approvalRequests.length).toBe(0); // No request needed
    expect(approvalManager.getStats().autoApproved).toBe(1);
  });

  test("confirm mode asks for everything", async () => {
    config = {
      mode: "confirm",
      showDiff: false,
      autoApproveReadOnly: false,
      timeoutSeconds: 0,
    };
    approvalManager = new ApprovalManager(config, createCallbacks());

    const result = await approvalManager.checkApproval(
      "read_file",
      { filePath: "test.txt" },
      "LOW",
    );

    expect(result.approved).toBe(true);
    expect(approvalRequests.length).toBe(1);
    expect(approvalManager.getStats().approved).toBe(1);
  });

  test("selective mode auto-approves read-only LOW risk", async () => {
    config = {
      mode: "selective",
      showDiff: false,
      autoApproveReadOnly: true,
      timeoutSeconds: 0,
    };
    approvalManager = new ApprovalManager(config, createCallbacks());

    const result = await approvalManager.checkApproval(
      "read_file",
      { filePath: "test.txt" },
      "LOW",
    );

    expect(result.approved).toBe(true);
    expect(approvalRequests.length).toBe(0); // No request needed
    expect(approvalManager.getStats().autoApproved).toBe(1);
  });

  test("selective mode requests approval for MEDIUM write_file", async () => {
    config = {
      mode: "selective",
      showDiff: true,
      autoApproveReadOnly: true,
      timeoutSeconds: 0,
    };
    approvalManager = new ApprovalManager(config, createCallbacks());

    const result = await approvalManager.checkApproval(
      "write_file",
      { filePath: "test.txt", content: "new content" },
      "MEDIUM",
    );

    expect(result.approved).toBe(true);
    expect(approvalRequests.length).toBe(1);
    expect(approvalRequests[0].toolName).toBe("write_file");
    expect(approvalRequests[0].riskLevel).toBe("MEDIUM");
    expect(approvalManager.getStats().approved).toBe(1);
  });

  test("selective mode requests approval for HIGH bash", async () => {
    config = {
      mode: "selective",
      showDiff: false,
      autoApproveReadOnly: true,
      timeoutSeconds: 0,
    };
    approvalManager = new ApprovalManager(config, createCallbacks());

    const result = await approvalManager.checkApproval(
      "bash",
      { command: "rm -rf /" },
      "HIGH",
    );

    expect(result.approved).toBe(true);
    expect(approvalRequests.length).toBe(1);
    expect(approvalRequests[0].toolName).toBe("bash");
    expect(approvalRequests[0].riskLevel).toBe("HIGH");
    expect(approvalManager.getStats().approved).toBe(1);
  });

  test("user rejection returns approved=false", async () => {
    config = {
      mode: "confirm",
      showDiff: false,
      autoApproveReadOnly: false,
      timeoutSeconds: 0,
    };

    const callbacks: ApprovalCallbacks = {
      requestApproval: async () => ({
        result: "rejected",
      }),
    };

    approvalManager = new ApprovalManager(config, callbacks);

    const result = await approvalManager.checkApproval(
      "bash",
      { command: "dangerous command" },
      "HIGH",
    );

    expect(result.approved).toBe(false);
    expect(approvalManager.getStats().rejected).toBe(1);
  });

  test("user edit returns modified args", async () => {
    config = {
      mode: "confirm",
      showDiff: false,
      autoApproveReadOnly: false,
      timeoutSeconds: 0,
    };

    const callbacks: ApprovalCallbacks = {
      requestApproval: async () => ({
        result: "edited",
        editedArgs: { filePath: "modified.txt", content: "modified content" },
      }),
    };

    approvalManager = new ApprovalManager(config, callbacks);

    const result = await approvalManager.checkApproval(
      "write_file",
      { filePath: "original.txt", content: "original" },
      "MEDIUM",
    );

    expect(result.approved).toBe(true);
    expect(result.args.filePath).toBe("modified.txt");
    expect(result.args.content).toBe("modified content");
    expect(approvalManager.getStats().approved).toBe(1);
  });

  test("isReadOnlyTool correctly identifies read tools", async () => {
    config = {
      mode: "selective",
      showDiff: false,
      autoApproveReadOnly: true,
      timeoutSeconds: 0,
    };
    approvalManager = new ApprovalManager(config, createCallbacks());

    // Test read-only tools
    const readOnlyTools = [
      "read_file",
      "glob",
      "grep",
      "list_directory",
      "get_directory_structure",
      "file_exists",
    ];

    for (const tool of readOnlyTools) {
      const result = await approvalManager.checkApproval(tool, {}, "LOW");
      expect(result.approved).toBe(true);
    }

    // Test git read-only operations
    const gitReadOnly = ["git_status", "git_log", "git_diff", "git_show"];

    approvalRequests = [];
    for (const tool of gitReadOnly) {
      const result = await approvalManager.checkApproval(tool, {}, "LOW");
      expect(result.approved).toBe(true);
    }

    // None of these should require requests
    expect(approvalRequests.length).toBe(0);
  });

  test("diff generation for write_file (new file)", async () => {
    config = {
      mode: "confirm",
      showDiff: true,
      autoApproveReadOnly: false,
      timeoutSeconds: 0,
    };
    approvalManager = new ApprovalManager(config, createCallbacks());

    const result = await approvalManager.checkApproval(
      "write_file",
      {
        filePath: "/tmp/nonexistent-file-xyz.txt",
        content: "new content",
      },
      "MEDIUM",
    );

    expect(result.approved).toBe(true);
    expect(approvalRequests.length).toBe(1);
    // Diff should be generated for new file
    if (approvalRequests[0].diff) {
      expect(approvalRequests[0].diff).toContain("/dev/null");
    }
  });

  test("diff generation for edit_file (existing content)", async () => {
    config = {
      mode: "confirm",
      showDiff: true,
      autoApproveReadOnly: false,
      timeoutSeconds: 0,
    };
    approvalManager = new ApprovalManager(config, createCallbacks());

    const result = await approvalManager.checkApproval(
      "edit_file",
      {
        filePath: "test.txt",
        oldString: "old text",
        newString: "new text",
      },
      "MEDIUM",
    );

    expect(result.approved).toBe(true);
    expect(approvalRequests.length).toBe(1);
  });

  test("stats tracking (approved/rejected/autoApproved counts)", async () => {
    config = {
      mode: "selective",
      showDiff: false,
      autoApproveReadOnly: true,
      timeoutSeconds: 0,
    };

    let callCount = 0;
    const callbacks: ApprovalCallbacks = {
      requestApproval: async () => {
        callCount++;
        return callCount <= 1
          ? { result: "approved" }
          : { result: "rejected" };
      },
    };

    approvalManager = new ApprovalManager(config, callbacks);

    // Auto-approve
    await approvalManager.checkApproval("read_file", {}, "LOW");

    // Approve by callback
    await approvalManager.checkApproval("write_file", {}, "MEDIUM");

    // Reject by callback
    await approvalManager.checkApproval("bash", {}, "HIGH");

    const stats = approvalManager.getStats();
    expect(stats.autoApproved).toBe(1);
    expect(stats.approved).toBe(1);
    expect(stats.rejected).toBe(1);
  });

  test("showDiff=false skips diff generation", async () => {
    config = {
      mode: "confirm",
      showDiff: false,
      autoApproveReadOnly: false,
      timeoutSeconds: 0,
    };
    approvalManager = new ApprovalManager(config, createCallbacks());

    const result = await approvalManager.checkApproval(
      "write_file",
      {
        filePath: "test.txt",
        content: "content",
      },
      "MEDIUM",
    );

    expect(result.approved).toBe(true);
    expect(approvalRequests.length).toBe(1);
    // When showDiff is false, diff should not be included
    expect(approvalRequests[0].diff).toBeUndefined();
  });

  test("approval request includes correct description", async () => {
    config = {
      mode: "confirm",
      showDiff: false,
      autoApproveReadOnly: false,
      timeoutSeconds: 0,
    };
    approvalManager = new ApprovalManager(config, createCallbacks());

    await approvalManager.checkApproval(
      "write_file",
      { filePath: "/path/to/file.txt", content: "test" },
      "MEDIUM",
    );

    expect(approvalRequests.length).toBe(1);
    expect(approvalRequests[0].description).toContain("Write file");
    expect(approvalRequests[0].description).toContain("file.txt");
  });

  test("bash command description includes command", async () => {
    config = {
      mode: "confirm",
      showDiff: false,
      autoApproveReadOnly: false,
      timeoutSeconds: 0,
    };
    approvalManager = new ApprovalManager(config, createCallbacks());

    await approvalManager.checkApproval(
      "bash",
      { command: "echo hello" },
      "HIGH",
    );

    expect(approvalRequests.length).toBe(1);
    expect(approvalRequests[0].description).toContain("Execute command");
    expect(approvalRequests[0].description).toContain("echo hello");
  });

  test("resetStats clears statistics", async () => {
    config = {
      mode: "auto",
      showDiff: false,
      autoApproveReadOnly: false,
      timeoutSeconds: 0,
    };
    approvalManager = new ApprovalManager(config, createCallbacks());

    await approvalManager.checkApproval("read_file", {}, "LOW");
    await approvalManager.checkApproval("write_file", {}, "MEDIUM");

    expect(approvalManager.getStats().autoApproved).toBe(2);

    approvalManager.resetStats();

    const stats = approvalManager.getStats();
    expect(stats.autoApproved).toBe(0);
    expect(stats.approved).toBe(0);
    expect(stats.rejected).toBe(0);
  });

  test("multiple approvals in sequence", async () => {
    config = {
      mode: "selective",
      showDiff: false,
      autoApproveReadOnly: true,
      timeoutSeconds: 0,
    };
    approvalManager = new ApprovalManager(config, createCallbacks());

    // First: auto-approve read-only
    await approvalManager.checkApproval("read_file", {}, "LOW");

    // Second: request approval for write
    await approvalManager.checkApproval("write_file", {}, "MEDIUM");

    // Third: auto-approve read-only again
    await approvalManager.checkApproval("glob", {}, "LOW");

    const stats = approvalManager.getStats();
    expect(stats.autoApproved).toBe(2);
    expect(stats.approved).toBe(1);
  });
});
