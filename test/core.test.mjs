import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderText, scan } from "../src/core.mjs";

function fixture(files = {}) {
  const parent = process.env.TMPDIR || os.tmpdir();
  const root = fs.mkdtempSync(path.join(parent, "agent-context-map-"));
  fs.mkdirSync(path.join(root, ".git"));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  return root;
}

function closeFixture(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function byFile(client, file) {
  return client.decisions.find((decision) => decision.file === file);
}

test("Codex selects a directory override and distinguishes target files from siblings", () => {
  const root = fixture({
    "AGENTS.md": "shared guidance\n",
    "AGENTS.override.md": "override guidance\n",
    "packages/api/AGENTS.md": "api guidance\n",
    "packages/api/src/route.ts": "export {};\n",
    "packages/web/AGENTS.md": "web guidance\n",
  });
  try {
    const result = scan({ root, launchDir: root, target: "packages/api/src/route.ts", agent: "codex" });
    const client = result.clients[0];
    assert.equal(byFile(client, "AGENTS.override.md").status, "predicted_included");
    assert.equal(byFile(client, "AGENTS.md").reasonCode, "same_directory_priority");
    assert.equal(byFile(client, "packages/api/AGENTS.md").status, "conditional");
    assert.equal(byFile(client, "packages/web/AGENTS.md").reasonCode, "outside_target_scope");
    assert.equal(result.limitations[0].includes("live session context was not inspected"), true);
  } finally {
    closeFixture(root);
  }
});

test("Claude default mode prefers a client file anywhere in the launch ancestry", () => {
  const root = fixture({
    "AGENTS.md": "shared guidance\n",
    "a/CLAUDE.md": "client guidance\n",
    "a/src/route.ts": "export {};\n",
  });
  try {
    const result = scan({ root, launchDir: path.join(root, "a"), target: "src/route.ts", agent: "claude" });
    const client = result.clients[0];
    assert.equal(byFile(client, "AGENTS.md").status, "skipped");
    assert.equal(byFile(client, "AGENTS.md").reasonCode, "claude_file_takes_default_mode");
    assert.equal(byFile(client, "a/CLAUDE.md").status, "predicted_included");
  } finally {
    closeFixture(root);
  }
});

test("Claude nested shared files are not suppressed by client files in parent directories", () => {
  const root = fixture({
    "AGENTS.md": "shared guidance\n",
    "packages/CLAUDE.md": "parent client guidance\n",
    "packages/src/AGENTS.md": "child shared guidance\n",
    "packages/src/route.ts": "export {};\n",
  });
  try {
    const result = scan({ root, launchDir: root, target: "packages/src/route.ts", agent: "claude" });
    const client = result.clients[0];
    assert.equal(byFile(client, "AGENTS.md").status, "predicted_included");
    assert.equal(byFile(client, "packages/CLAUDE.md").status, "conditional");
    assert.equal(byFile(client, "packages/src/AGENTS.md").status, "conditional");
  } finally {
    closeFixture(root);
  }
});

test("Claude default mode prefers client-specific files and marks nested files conditional", () => {
  const root = fixture({
    "AGENTS.md": "shared guidance\n",
    "CLAUDE.md": "client guidance\n",
    "packages/api/AGENTS.md": "api guidance\n",
    "packages/api/CLAUDE.md": "api client guidance\n",
    "packages/api/src/route.ts": "export {};\n",
  });
  try {
    const result = scan({ root, launchDir: root, target: "packages/api/src/route.ts", agent: "claude" });
    const client = result.clients[0];
    assert.equal(byFile(client, "CLAUDE.md").status, "predicted_included");
    assert.equal(byFile(client, "AGENTS.md").reasonCode, "claude_file_takes_default_mode");
    assert.equal(byFile(client, "packages/api/CLAUDE.md").status, "conditional");
    assert.equal(byFile(client, "packages/api/AGENTS.md").reasonCode, "claude_file_takes_default_mode");
  } finally {
    closeFixture(root);
  }
});

test("Cursor evaluates always, matching, missing, and manual rule activation", () => {
  const root = fixture({
    "AGENTS.md": "shared guidance\n",
    "packages/api/AGENTS.md": "api guidance\n",
    "packages/api/src/route.ts": "export {};\n",
    "packages/web/AGENTS.md": "web guidance\n",
    ".cursor/rules/always.mdc": "---\nalwaysApply: true\n---\nAlways apply.\n",
    ".cursor/rules/api.mdc": "---\nglobs: \"packages/api/**/*.ts\"\nalwaysApply: false\n---\nAPI files.\n",
    ".cursor/rules/no-match.mdc": "---\nglobs: \"packages/api/**/*.py\"\nalwaysApply: false\n---\nPython files.\n",
    ".cursor/rules/intelligent.mdc": "---\ndescription: Choose when relevant\n---\nGuidance.\n",
    ".cursor/rules/manual.mdc": "---\n---\nGuidance.\n",
  });
  try {
    const result = scan({ root, launchDir: root, target: "packages/api/src/route.ts", agent: "cursor" });
    const client = result.clients[0];
    assert.equal(byFile(client, "AGENTS.md").status, "predicted_included");
    assert.equal(byFile(client, "packages/api/AGENTS.md").status, "conditional");
    assert.equal(byFile(client, "packages/web/AGENTS.md").status, "skipped");
    assert.equal(byFile(client, ".cursor/rules/always.mdc").status, "predicted_included");
    assert.equal(byFile(client, ".cursor/rules/api.mdc").status, "conditional");
    assert.equal(byFile(client, ".cursor/rules/no-match.mdc").status, "skipped");
    assert.equal(byFile(client, ".cursor/rules/intelligent.mdc").status, "unknown");
    assert.equal(byFile(client, ".cursor/rules/manual.mdc").reasonCode, "cursor_manual_rule");
  } finally {
    closeFixture(root);
  }
});

test("Codex applies its documented combined byte limit to launch files", () => {
  const root = fixture({
    "AGENTS.md": "a".repeat(20000),
    "a/AGENTS.md": "b".repeat(15000),
    "a/route.ts": "export {};\n",
  });
  try {
    const result = scan({ root, launchDir: path.join(root, "a"), target: "route.ts", agent: "codex" });
    const client = result.clients[0];
    assert.equal(byFile(client, "AGENTS.md").includedBytes, 20000);
    assert.equal(byFile(client, "a/AGENTS.md").partiallyIncluded, true);
    assert.equal(byFile(client, "a/AGENTS.md").includedBytes, 32 * 1024 - 20000);
  } finally {
    closeFixture(root);
  }
});

test("symlink instructions remain unknown and are not followed", () => {
  const root = fixture({ "outside.md": "private\n", "packages/api/src/route.ts": "export {};\n" });
  try {
    fs.symlinkSync(path.join(root, "outside.md"), path.join(root, "AGENTS.md"));
    const result = scan({ root, launchDir: root, target: "packages/api/src/route.ts", agent: "codex" });
    assert.equal(byFile(result.clients[0], "AGENTS.md").status, "unknown");
    assert.equal(byFile(result.clients[0], "AGENTS.md").reasonCode, "candidate_symbolic_link");
  } finally {
    closeFixture(root);
  }
});

test("target paths outside the selected repository root fail clearly", () => {
  const root = fixture();
  try {
    assert.throws(
      () => scan({ root, launchDir: root, target: "../outside.ts", agent: "codex" }),
      /inside the repository root/,
    );
  } finally {
    closeFixture(root);
  }
});

test("scan limits are visible in warnings", () => {
  const root = fixture({ "AGENTS.md": "guidance\n", "a.txt": "one\n", "b.txt": "two\n" });
  try {
    const result = scan({ root, launchDir: root, target: ".", agent: "codex", maxFiles: 1 });
    assert.equal(result.scan.truncated, true);
    assert.equal(result.warnings.some((warning) => warning.code === "file_limit"), true);
  } finally {
    closeFixture(root);
  }
});

test("text output names the target and labels results without claiming live context", () => {
  const root = fixture({
    "AGENTS.md": "guidance\n",
    "packages/api/src/route.ts": "export {};\n",
  });
  try {
    const result = scan({ root, launchDir: root, target: "packages/api/src/route.ts", agent: "codex" });
    const output = renderText(result, { color: false });
    assert.match(output, /Target: packages\/api\/src\/route\.ts/);
    assert.match(output, /\[PREDICTED\]/);
    assert.match(output, /\[TARGET\]/);
    assert.match(output, /live session context was not inspected/);
    assert.doesNotMatch(output, /\u001b\[/);
  } finally {
    closeFixture(root);
  }
});

test("text output marks an empty directory target as a directory", () => {
  const root = fixture();
  const target = path.join(root, "packages/empty");
  fs.mkdirSync(target, { recursive: true });
  try {
    const result = scan({ root, launchDir: root, target: "packages/empty", agent: "codex" });
    const output = renderText(result, { color: false });
    assert.match(output, /\\-- empty\/ \[TARGET\]/);
  } finally {
    closeFixture(root);
  }
});
