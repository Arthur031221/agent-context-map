import fs from "node:fs";
import path from "node:path";
import {
  CLIENT_IDS,
  CODEX_PROJECT_DOC_LIMIT,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_FILES,
  EXCLUDED_DIRS,
  MAX_CANDIDATE_BYTES,
  RULESETS,
  SCHEMA_VERSION,
} from "./rules.mjs";

const CODEX_FILES = ["AGENTS.override.md", "AGENTS.md"];
const CLAUDE_FILES = ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"];
const CLAUDE_AGENT_FILES = ["AGENTS.md", ".claude/AGENTS.md"];
const CURSOR_AGENT_FILES = ["AGENTS.md", "CLAUDE.md"];

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function isWithin(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function relPath(root, candidate) {
  const relative = toPosix(path.relative(root, candidate));
  return relative || ".";
}

function directoryChain(root, directory) {
  if (!isWithin(root, directory)) return [];
  const relative = path.relative(root, directory);
  const parts = relative ? relative.split(path.sep).filter(Boolean) : [];
  const result = [root];
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    result.push(current);
  }
  return result;
}

function findGitRoot(start) {
  let current = path.resolve(start);
  try {
    if (!fs.statSync(current).isDirectory()) current = path.dirname(current);
  } catch {
    current = path.dirname(current);
  }
  while (true) {
    try {
      fs.lstatSync(path.join(current, ".git"));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

function isSkillPath(relative) {
  return /^(?:\.agents|\.claude|\.cursor)\/skills\/.+\/SKILL\.md$/.test(relative);
}

function isClaudeRulePath(relative) {
  return /(?:^|\/)\.claude\/rules\/.+\.md$/.test(relative);
}

function isCursorRulePath(relative) {
  return /(?:^|\/)\.cursor\/rules\/.+\.mdc$/.test(relative);
}

function isCandidatePath(relative) {
  const basename = path.posix.basename(relative);
  return [
    "AGENTS.md",
    "AGENTS.override.md",
    "CLAUDE.md",
    "CLAUDE.local.md",
    ".cursorrules",
  ].includes(basename) ||
    isClaudeRulePath(relative) ||
    isCursorRulePath(relative) ||
    isSkillPath(relative);
}

function inspectCandidate(root, relative, kind) {
  const absolute = path.join(root, ...relative.split("/"));
  if (kind === "symlink") {
    return { file: relative, absolute, kind, size: null, content: null, readError: "symbolic_link" };
  }
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) {
      return { file: relative, absolute, kind, size: null, content: null, readError: "not_a_file" };
    }
    if (stat.size > MAX_CANDIDATE_BYTES) {
      return { file: relative, absolute, kind, size: stat.size, content: null, readError: "file_too_large" };
    }
    const bytes = fs.readFileSync(absolute);
    let content;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { file: relative, absolute, kind, size: stat.size, content: null, readError: "invalid_utf8" };
    }
    return { file: relative, absolute, kind, size: stat.size, content, readError: null };
  } catch (error) {
    return {
      file: relative,
      absolute,
      kind,
      size: null,
      content: null,
      readError: error.code || "read_failed",
    };
  }
}

function walkWorkspace(root, { maxFiles, maxDepth }) {
  const candidates = [];
  const warnings = [];
  let visitedFiles = 0;
  let truncated = false;

  function visit(directory, depth) {
    if (depth > maxDepth || truncated) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      warnings.push({
        code: "directory_unreadable",
        path: relPath(root, directory),
        detail: error.code || "read_failed",
      });
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (truncated) return;
      const absolute = path.join(directory, entry.name);
      const relative = relPath(root, absolute);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        if (depth === maxDepth) {
          warnings.push({ code: "depth_limit", path: relative });
          continue;
        }
        visit(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      visitedFiles += 1;
      if (visitedFiles > maxFiles) {
        truncated = true;
        warnings.push({ code: "file_limit", limit: maxFiles });
        return;
      }
      if (isCandidatePath(relative)) {
        candidates.push(inspectCandidate(root, relative, entry.isSymbolicLink() ? "symlink" : "file"));
      }
    }
  }

  visit(root, 0);
  return { candidates, warnings, truncated, visitedFiles: Math.min(visitedFiles, maxFiles) };
}

function makeDecision(candidate, status, reasonCode, reason, extra = {}) {
  return { file: candidate.file, status, reasonCode, reason, sizeBytes: candidate.size, ...extra };
}

function unreadableDecision(candidate) {
  const messages = {
    symbolic_link: "The file is a symlink. Its target was not followed.",
    file_too_large: "The file is larger than the inspection limit.",
    invalid_utf8: "The file is not valid UTF-8, so its contents were not parsed.",
    not_a_file: "The instruction path is not a regular file.",
  };
  return makeDecision(
    candidate,
    "unknown",
    "candidate_" + (candidate.readError || "unreadable"),
    messages[candidate.readError] || "The file could not be read (" + (candidate.readError || "unknown error") + ").",
  );
}

function scopedDirectory(candidate, root) {
  const parts = candidate.file.split("/");
  if (parts.length >= 2 && parts.at(-2) === ".claude" &&
      ["CLAUDE.md", "AGENTS.md"].includes(parts.at(-1))) {
    return path.join(root, ...parts.slice(0, -2));
  }
  return path.dirname(candidate.absolute);
}

function selectedByPriority(candidates, root) {
  const byDirectory = new Map();
  for (const candidate of candidates) {
    const directory = scopedDirectory(candidate, root);
    if (!byDirectory.has(directory)) byDirectory.set(directory, []);
    byDirectory.get(directory).push(candidate);
  }
  const selected = new Map();
  const ordered = new Map();
  for (const [directory, files] of byDirectory) {
    files.sort((left, right) => CODEX_FILES.indexOf(path.basename(left.file)) - CODEX_FILES.indexOf(path.basename(right.file)));
    ordered.set(directory, files);
    selected.set(directory, files[0]);
  }
  return { selected, ordered };
}

function planCodexLaunchBudget(selected, ordered, launchChain) {
  const plans = new Map();
  let remaining = CODEX_PROJECT_DOC_LIMIT;
  let certain = true;

  for (const directory of launchChain) {
    const candidate = selected.get(directory);
    if (!candidate) continue;
    const alternatives = ordered.get(directory) || [];
    if (candidate.readError) {
      certain = false;
      continue;
    }
    if (candidate.size === 0) {
      if (alternatives.length > 1) certain = false;
      continue;
    }
    if (!certain) {
      plans.set(candidate.file, {
        status: "unknown",
        reasonCode: "byte_limit_uncertain",
        reason: "An unresolved launch instruction could consume part of the combined byte limit, so this file's included byte count is uncertain.",
      });
      continue;
    }
    if (remaining === 0) {
      plans.set(candidate.file, {
        status: "skipped",
        reasonCode: "byte_limit_reached",
        reason: "The combined project-instruction byte limit was already reached.",
      });
      continue;
    }
    const includedBytes = Math.min(candidate.size, remaining);
    remaining -= includedBytes;
    const partial = includedBytes < candidate.size;
    plans.set(candidate.file, {
      status: "predicted_included",
      reasonCode: partial ? "byte_limit_partial" : "selected_at_launch",
      reason: partial
        ? "Selected at launch, with " + includedBytes + " of " + candidate.size + " bytes before the combined limit."
        : "Selected by filename priority on the path from the repository root to the launch directory.",
      extra: { includedBytes, partiallyIncluded: partial },
    });
  }
  return plans;
}

function resolveCodex(candidates, root, launchChain, targetChain) {
  const codexCandidates = candidates.filter((candidate) =>
    ["AGENTS.override.md", "AGENTS.md"].includes(path.basename(candidate.file)) &&
    !candidate.file.startsWith(".claude/") &&
    !candidate.file.includes("/.claude/"),
  );
  const { selected, ordered } = selectedByPriority(codexCandidates, root);
  const launchPlans = planCodexLaunchBudget(selected, ordered, launchChain);
  const decisions = [];

  for (const candidate of codexCandidates) {
    const directory = scopedDirectory(candidate, root);
    const chosen = selected.get(directory);
    const alternatives = ordered.get(directory) || [];
    const launchScope = launchChain.includes(directory);
    const targetScope = targetChain.includes(directory);
    if (!launchScope && !targetScope) {
      decisions.push(makeDecision(candidate, "skipped", "outside_target_scope", "This file is outside the launch and target paths."));
      continue;
    }
    if (chosen !== candidate) {
      const chosenError = chosen?.readError || (chosen?.size === 0 ? "empty" : null);
      if (chosenError) {
        decisions.push(makeDecision(candidate, "unknown", "priority_source_unresolved", "A higher-priority file could not be evaluated, so selection is uncertain.", {
          selectedFile: chosen.file,
        }));
      } else {
        decisions.push(makeDecision(candidate, "skipped", "same_directory_priority", "A higher-priority file was selected in this directory.", {
          selectedFile: chosen.file,
        }));
      }
      continue;
    }
    if (candidate.readError) {
      decisions.push(unreadableDecision(candidate));
      continue;
    }
    if (candidate.size === 0) {
      decisions.push(makeDecision(candidate, "skipped", "empty_file", "Empty instruction files are ignored."));
      if (alternatives.length > 1) {
        for (const fallback of alternatives.slice(1)) {
          const found = decisions.find((decision) => decision.file === fallback.file);
          if (found) {
            found.status = "unknown";
            found.reasonCode = "empty_priority_behavior_unknown";
            found.reason = "Public documentation says empty files are ignored but does not specify whether a lower-priority file is then selected.";
          }
        }
      }
      continue;
    }
    if (launchScope) {
      const plan = launchPlans.get(candidate.file);
      if (plan) {
        decisions.push(makeDecision(candidate, plan.status, plan.reasonCode, plan.reason, plan.extra));
      } else {
        decisions.push(makeDecision(candidate, "unknown", "byte_limit_uncertain", "The combined byte limit could not be allocated confidently for this launch instruction."));
      }
    } else {
      decisions.push(makeDecision(candidate, "conditional", "nested_directory_access", "This file is outside the startup chain. It may apply if explicitly read or if a new session starts in this directory.", {
        phase: "target_access",
      }));
    }
  }
  for (const candidate of candidates) {
    if (codexCandidates.includes(candidate) || isSkillPath(candidate.file)) continue;
    if (
      ["CLAUDE.md", "CLAUDE.local.md", ".cursorrules"].includes(path.posix.basename(candidate.file)) ||
      isClaudeRulePath(candidate.file) ||
      isCursorRulePath(candidate.file) ||
      candidate.file.startsWith(".claude/")
    ) {
      decisions.push(makeDecision(candidate, "skipped", "not_a_codex_project_file", "This path is not part of the documented project instruction chain."));
    }
  }
  return decisions.sort((left, right) => left.file.localeCompare(right.file));
}

function isClaudePrimary(candidate, root) {
  const scope = scopedDirectory(candidate, root);
  return CLAUDE_FILES.some((name) => candidate.file === relPath(root, path.join(scope, name)));
}

function hasClaudeInPath(candidates, directory, root) {
  return candidates.some((candidate) =>
    !candidate.readError && candidate.size !== 0 &&
    isClaudePrimary(candidate, root) &&
    isWithin(scopedDirectory(candidate, root), directory),
  );
}

function hasClaudeInDirectory(candidates, directory, root) {
  return candidates.some((candidate) =>
    !candidate.readError && candidate.size !== 0 &&
    isClaudePrimary(candidate, root) &&
    scopedDirectory(candidate, root) === directory,
  );
}

function resolveClaude(candidates, root, launchChain, targetChain, mode) {
  const decisions = [];
  const launchHasClaude = hasClaudeInPath(candidates, launchChain.at(-1), root);
  for (const candidate of candidates) {
    const isShared = CLAUDE_AGENT_FILES.some((name) => candidate.file === relPath(root, path.join(scopedDirectory(candidate, root), name)));
    if (isSkillPath(candidate.file)) continue;
    if (isClaudeRulePath(candidate.file)) {
      decisions.push(makeDecision(candidate, "unknown", "claude_path_rules_unresolved", "Path-scoped rule activation is not modeled in this release."));
      continue;
    }
    const isClaudeFile = isClaudePrimary(candidate, root);
    if (!isClaudeFile && !isShared) {
      if (
        path.posix.basename(candidate.file) === "AGENTS.override.md" ||
        path.posix.basename(candidate.file) === ".cursorrules" ||
        isCursorRulePath(candidate.file)
      ) {
        decisions.push(makeDecision(candidate, "skipped", "not_a_claude_project_file", "This path is not part of the documented project instruction chain."));
      }
      continue;
    }
    const directory = scopedDirectory(candidate, root);
    const launchScope = launchChain.includes(directory);
    const targetScope = targetChain.includes(directory);
    if (!launchScope && !targetScope) {
      decisions.push(makeDecision(candidate, "skipped", "outside_target_scope", "This file is outside the launch and target paths."));
      continue;
    }
    if (candidate.readError) {
      decisions.push(unreadableDecision(candidate));
      continue;
    }
    if (candidate.size === 0) {
      decisions.push(makeDecision(candidate, "skipped", "empty_file", "The file is empty."));
      continue;
    }
    if (mode === "claude-only" && !isClaudeFile) {
      decisions.push(makeDecision(candidate, "skipped", "claude_only_mode", "The selected mode reads client-specific instruction files only."));
      continue;
    }
    const clientFileTakesPrecedence = launchScope
      ? launchHasClaude
      : hasClaudeInDirectory(candidates, directory, root);
    if (mode === "default" && !isClaudeFile && clientFileTakesPrecedence) {
      decisions.push(makeDecision(candidate, "skipped", "claude_file_takes_default_mode", "A client-specific file in the launch path or this directory takes precedence over shared instruction files in default mode."));
      continue;
    }
    if (launchScope) {
      decisions.push(makeDecision(candidate, "predicted_included", isClaudeFile ? "client_file_at_launch" : "shared_file_at_launch", isClaudeFile
        ? "Client-specific instruction file is on the path to the launch directory."
        : "Shared instruction file is on the path to the launch directory."));
    } else {
      decisions.push(makeDecision(candidate, "conditional", "nested_file_access", "This file may load when a file in this directory is opened.", {
        phase: "target_access",
      }));
    }
  }
  return decisions.sort((left, right) => left.file.localeCompare(right.file));
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function splitGlobList(value) {
  return value.split(",").map((item) => unquote(item.trim())).filter(Boolean);
}

function parseFrontmatter(content) {
  const match = content.match(/^\uFEFF?---\r?\n([\s\S]*?)(?:\r?\n)?---(?:\r?\n|$)/);
  if (!match) return { supported: true, hasFrontmatter: false, alwaysApply: null, globs: null, description: false };
  const lines = match[1].split(/\r?\n/);
  let alwaysApply = null;
  let globs = null;
  let description = false;
  let invalid = false;

  for (let index = 0; index < lines.length; index += 1) {
    const field = lines[index].match(/^\s*(alwaysApply|globs|description)\s*:\s*(.*)$/);
    if (!field) continue;
    const key = field[1];
    const value = field[2].trim();
    if (key === "alwaysApply") {
      if (/^(true|false)$/i.test(value)) alwaysApply = value.toLowerCase() === "true";
      else invalid = true;
    } else if (key === "description") {
      description = value.length > 0;
    } else if (key === "globs") {
      if (!value) {
        const items = [];
        for (let next = index + 1; next < lines.length && /^\s+-\s+/.test(lines[next]); next += 1) {
          items.push(unquote(lines[next].replace(/^\s+-\s+/, "").trim()));
          index = next;
        }
        globs = items;
      } else if (value.startsWith("[") && value.endsWith("]")) {
        globs = splitGlobList(value.slice(1, -1));
      } else {
        globs = splitGlobList(value);
      }
      if (!Array.isArray(globs) || globs.length === 0 || globs.some((item) => !item)) invalid = true;
    }
  }
  return { supported: !invalid, hasFrontmatter: true, alwaysApply, globs, description };
}

function globToRegExp(glob) {
  const normalized = glob.replace(/^\.\//, "").replace(/^\/+/, "");
  if (/[{}[\]\\!]/.test(normalized)) return null;
  const special = ".^$+()|[]{}\\";
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      index += 1;
      if (normalized[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += special.includes(character) ? "\\" + character : character;
    }
  }
  return new RegExp("^" + source + "$");
}

function matchGlobSet(globs, targetPath, targetIsDirectory) {
  if (targetIsDirectory) {
    return { matched: false, supported: true, reason: "A directory target has no file path to match; open a file beneath it to test this rule." };
  }
  for (const glob of globs) {
    const expression = globToRegExp(glob);
    if (!expression) return { matched: false, supported: false, reason: "The glob pattern " + glob + " uses syntax this release does not evaluate." };
    if (expression.test(targetPath)) return { matched: true, supported: true, matchedGlob: glob };
  }
  return { matched: false, supported: true };
}

function resolveCursor(candidates, root, launchChain, targetChain, targetPath, targetIsDirectory) {
  const decisions = [];
  const cursorCandidates = candidates.filter((candidate) =>
    CURSOR_AGENT_FILES.some((name) => path.basename(candidate.file) === name) ||
    candidate.file === ".cursorrules" ||
    path.basename(candidate.file) === "AGENTS.override.md" ||
    path.basename(candidate.file) === "CLAUDE.local.md" ||
    isClaudeRulePath(candidate.file) ||
    isCursorRulePath(candidate.file),
  );
  for (const candidate of cursorCandidates) {
    if (
      path.basename(candidate.file) === "AGENTS.override.md" ||
      path.basename(candidate.file) === "CLAUDE.local.md" ||
      isClaudeRulePath(candidate.file) ||
      (candidate.file.startsWith(".claude/") && !candidate.file.startsWith(".claude/rules/"))
    ) {
      decisions.push(makeDecision(candidate, "skipped", "not_a_cursor_project_file", "This path is not part of the documented project instruction chain."));
      continue;
    }
    if (candidate.readError) {
      decisions.push(unreadableDecision(candidate));
      continue;
    }
    const directory = scopedDirectory(candidate, root);
    const launchScope = launchChain.includes(directory);
    const targetScope = targetChain.includes(directory);
    if (isCursorRulePath(candidate.file)) {
      if (!candidate.file.startsWith(".cursor/rules/")) {
        decisions.push(makeDecision(candidate, "unknown", "nested_cursor_rules_directory", "Rules stored outside the workspace .cursor/rules directory are not evaluated."));
        continue;
      }
      const metadata = parseFrontmatter(candidate.content);
      if (!metadata.supported) {
        decisions.push(makeDecision(candidate, "unknown", "invalid_cursor_frontmatter", "The rule frontmatter uses a value this release cannot parse."));
        continue;
      }
      if (!metadata.hasFrontmatter) {
        decisions.push(makeDecision(candidate, "unknown", "cursor_frontmatter_missing", "The rule file has no frontmatter, so its activation cannot be predicted."));
        continue;
      }
      if (metadata.alwaysApply === true) {
        decisions.push(makeDecision(candidate, "predicted_included", "cursor_always_apply", "Frontmatter sets alwaysApply to true."));
        continue;
      }
      if (metadata.globs) {
        const result = matchGlobSet(metadata.globs, targetPath, targetIsDirectory);
        if (!result.supported) {
          decisions.push(makeDecision(candidate, "unknown", "cursor_glob_unsupported", result.reason));
        } else if (result.matched) {
          decisions.push(makeDecision(candidate, "conditional", "cursor_glob_match", "Eligible when a matching file is in context (" + result.matchedGlob + ").", {
            phase: "target_access",
            matchedGlob: result.matchedGlob,
          }));
        } else {
          decisions.push(makeDecision(candidate, targetIsDirectory ? "unknown" : "skipped", targetIsDirectory ? "cursor_directory_target" : "cursor_glob_miss", result.reason || "No frontmatter glob matches the target file."));
        }
        continue;
      }
      if (metadata.description) {
        decisions.push(makeDecision(candidate, "unknown", "cursor_intelligent_rule", "The rule has a description but no file glob; relevance is chosen by the agent."));
      } else {
        decisions.push(makeDecision(candidate, "skipped", "cursor_manual_rule", "The rule has no automatic activation fields and may need a manual mention."));
      }
      continue;
    }
    if (candidate.file === ".cursorrules") {
      if (directory === root) {
        decisions.push(makeDecision(candidate, "predicted_included", "cursor_legacy_root_file", "Legacy root instruction file is recognized by the documented project rules."));
      } else {
        decisions.push(makeDecision(candidate, "skipped", "cursor_legacy_file_outside_root", "The legacy instruction file is not at the workspace root."));
      }
      continue;
    }
    if (!launchScope && !targetScope) {
      decisions.push(makeDecision(candidate, "skipped", "outside_target_scope", "This file is outside the launch and target paths."));
    } else if (candidate.size === 0) {
      decisions.push(makeDecision(candidate, "skipped", "empty_file", "The file is empty."));
    } else if (launchScope) {
      decisions.push(makeDecision(candidate, "predicted_included", "cursor_instruction_in_scope", "Instruction file is on the path from the workspace root to the launch directory."));
    } else {
      decisions.push(makeDecision(candidate, "conditional", "cursor_nested_instruction", "This file applies when work reaches its directory or a child.", {
        phase: "target_access",
      }));
    }
  }
  return decisions.sort((left, right) => left.file.localeCompare(right.file));
}

function buildClient(id, decisions, options) {
  return {
    id,
    name: RULESETS[id].name,
    rulesetId: RULESETS[id].id,
    source: RULESETS[id].source,
    sourceSummary: RULESETS[id].sourceSummary,
    assumptions: id === "codex"
      ? ["Default project instruction filenames are assumed; custom fallback filenames and byte-limit settings were not read."]
      : id === "claude"
        ? ["Project instruction mode is assumed to be " + (options.claudeMode === "default" ? "the documented default" : options.claudeMode) + ".", "User and managed organization instructions were not read."]
        : ["User and team rules are not read.", "Only the workspace .cursor/rules directory is parsed."],
    decisions,
  };
}

export function scan(options = {}) {
  const launchDirectory = path.resolve(options.launchDir || process.cwd());
  let launchStat;
  try {
    launchStat = fs.statSync(launchDirectory);
  } catch {
    throw new Error("Launch directory does not exist: " + launchDirectory);
  }
  if (!launchStat.isDirectory()) throw new Error("Launch path is not a directory: " + launchDirectory);
  const targetArgument = options.target || ".";
  const targetAbsolute = path.resolve(launchDirectory, targetArgument);
  const foundGitRoot = findGitRoot(launchDirectory);
  const workspaceRoot = options.root ? path.resolve(options.root) : foundGitRoot || launchDirectory;
  let rootStat;
  try {
    rootStat = fs.statSync(workspaceRoot);
  } catch {
    throw new Error("Repository root does not exist: " + workspaceRoot);
  }
  if (!rootStat.isDirectory()) throw new Error("Repository root is not a directory: " + workspaceRoot);
  if (!isWithin(workspaceRoot, launchDirectory)) throw new Error("The launch directory must be inside the repository root.");
  if (!isWithin(workspaceRoot, targetAbsolute)) throw new Error("The target path must be inside the repository root.");

  let targetStat = null;
  try {
    targetStat = fs.statSync(targetAbsolute);
  } catch {
    targetStat = null;
  }
  const targetIsDirectory = targetStat ? targetStat.isDirectory() : false;
  const targetAnchor = targetIsDirectory ? targetAbsolute : path.dirname(targetAbsolute);
  const launchChain = directoryChain(workspaceRoot, launchDirectory);
  const targetChain = directoryChain(workspaceRoot, targetAnchor);
  const targetPath = relPath(workspaceRoot, targetAbsolute);
  const maxFiles = Number.isInteger(options.maxFiles) ? options.maxFiles : DEFAULT_MAX_FILES;
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : DEFAULT_MAX_DEPTH;
  if (maxFiles < 1 || maxDepth < 0) throw new Error("Scan limits must be positive.");
  const walked = walkWorkspace(workspaceRoot, { maxFiles, maxDepth });
  const claudeMode = options.claudeMode || "default";
  if (!["default", "both", "claude-only"].includes(claudeMode)) {
    throw new Error("Claude mode must be default, both, or claude-only.");
  }
  const ids = options.agent === "all" || !options.agent ? CLIENT_IDS : [options.agent];
  const unsupported = ids.filter((id) => !CLIENT_IDS.includes(id));
  if (unsupported.length) throw new Error("Unknown client id: " + unsupported.join(", "));
  const clients = ids.map((id) => {
    const decisions = id === "codex"
      ? resolveCodex(walked.candidates, workspaceRoot, launchChain, targetChain)
      : id === "claude"
        ? resolveClaude(walked.candidates, workspaceRoot, launchChain, targetChain, claudeMode)
        : resolveCursor(walked.candidates, workspaceRoot, launchChain, targetChain, targetPath, targetIsDirectory);
    return buildClient(id, decisions, { claudeMode });
  });
  const skills = walked.candidates.filter((candidate) => isSkillPath(candidate.file)).map((candidate) => candidate.file);
  const warnings = [...walked.warnings];
  if (skills.length) {
    warnings.push({
      code: "skills_not_mapped",
      files: skills,
      detail: "Skill discovery is outside this release. These files are not included in client decisions.",
    });
  }
  if (!options.root && !foundGitRoot) {
    warnings.push({
      code: "no_git_root",
      detail: "No Git root was found; the launch directory is used as the repository root.",
    });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    toolVersion: "0.1.0",
    target: { path: targetPath, type: targetIsDirectory ? "directory" : "file" },
    launchDirectory: relPath(workspaceRoot, launchDirectory),
    repositoryRoot: ".",
    repositoryRootSource: options.root ? "explicit" : foundGitRoot ? "git" : "launch_directory",
    limitations: [
      "Static prediction under dated documentation rulesets; live session context was not inspected.",
      "Only repository-local files are examined. User, account, organization, and team settings are not read.",
      "Directory scanning skips common generated folders and stops at configured depth and file limits.",
    ],
    clients,
    warnings,
    scan: { visitedFiles: walked.visitedFiles, truncated: walked.truncated },
  };
}

const STATUS_LABELS = {
  predicted_included: "PREDICTED",
  conditional: "CONDITIONAL",
  skipped: "SKIPPED",
  unknown: "UNKNOWN",
};

const STATUS_COLORS = {
  predicted_included: "\u001b[32m",
  conditional: "\u001b[33m",
  skipped: "\u001b[90m",
  unknown: "\u001b[31m",
};

function addTreePath(tree, relative, decision, isTarget, targetIsDirectory = false) {
  const parts = relative === "." ? [] : relative.split("/");
  let current = tree;
  for (const part of parts) {
    if (!current.children.has(part)) {
      current.children.set(part, { name: part, children: new Map(), decision: null, target: false, directory: false });
    }
    current = current.children.get(part);
  }
  if (decision) current.decision = decision;
  if (isTarget) {
    current.target = true;
    current.directory = targetIsDirectory;
  }
}

function treeForClient(client, targetPath, targetIsDirectory) {
  const tree = { name: ".", children: new Map(), decision: null, target: false };
  for (const decision of client.decisions) addTreePath(tree, decision.file, decision, false);
  addTreePath(tree, targetPath, null, true, targetIsDirectory);
  const lines = ["  ."];
  function visit(node, prefix) {
    const children = [...node.children.values()].sort((left, right) => left.name.localeCompare(right.name));
    children.forEach((child, index) => {
      const last = index === children.length - 1;
      const connector = last ? "\\-- " : "|-- ";
      const continuation = last ? "    " : "|   ";
      const isDirectory = child.directory || child.children.size > 0;
      let label = child.name + (isDirectory ? "/" : "");
      if (child.target) label += " [TARGET]";
      if (child.decision) label += " [" + STATUS_LABELS[child.decision.status] + "] " + child.decision.reason;
      lines.push(prefix + connector + label);
      if (isDirectory) visit(child, prefix + continuation);
    });
  }
  visit(tree, "  ");
  return lines;
}

export function renderText(result, { color = Boolean(process.stdout.isTTY && !process.env.NO_COLOR) } = {}) {
  const lines = [
    "agent-context-map " + result.toolVersion,
    "Target: " + result.target.path + " (" + result.target.type + ")",
    "Launch directory: " + result.launchDirectory,
    "Repository root: . (" + result.repositoryRootSource + ")",
    "Repository files only. This is a static prediction; live session context was not inspected.",
  ];
  for (const client of result.clients) {
    lines.push("");
    lines.push(client.name + " (" + client.rulesetId + ")");
    for (const line of treeForClient(client, result.target.path, result.target.type === "directory")) {
      if (!color) {
        lines.push(line);
      } else {
        const colored = line.replace(/\[(PREDICTED|CONDITIONAL|SKIPPED|UNKNOWN)\]/, (label) => {
          const status = label === "[PREDICTED]" ? "predicted_included"
            : label === "[CONDITIONAL]" ? "conditional"
              : label === "[SKIPPED]" ? "skipped" : "unknown";
          return STATUS_COLORS[status] + label + "\u001b[0m";
        });
        lines.push(colored);
      }
    }
  }
  if (result.warnings.length) {
    lines.push("");
    lines.push("Coverage warnings:");
    for (const warning of result.warnings) {
      const location = warning.path ? " " + warning.path : "";
      lines.push("  - " + warning.code + location + ": " + (warning.detail || warning.code));
    }
  }
  return lines.join("\n");
}
