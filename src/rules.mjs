export const RULESETS = {
  codex: {
    id: "codex-cli-docs-2026-10-02",
    name: "Codex CLI",
    source: "https://developers.openai.com/codex/guides/agents-md",
    sourceSummary: "Project instructions use ancestor lookup, per-directory filename priority, empty-file skipping, and a combined byte limit.",
  },
  claude: {
    id: "claude-code-docs-2026-10-02",
    name: "Claude Code",
    source: "https://code.claude.com/docs/en/memory",
    sourceSummary: "Project instructions use ancestor files at launch, with nested files loaded when a file there is opened.",
  },
  cursor: {
    id: "cursor-docs-2026-10-02",
    name: "Cursor Agent",
    source: "https://cursor.com/docs/rules",
    sourceSummary: "Project instructions include nested AGENTS.md files and path-scoped rules with frontmatter.",
  },
};

export const CLIENT_IDS = Object.keys(RULESETS);
export const SCHEMA_VERSION = 1;
export const CODEX_PROJECT_DOC_LIMIT = 32 * 1024;
export const MAX_CANDIDATE_BYTES = 512 * 1024;
export const DEFAULT_MAX_FILES = 10000;
export const DEFAULT_MAX_DEPTH = 16;

export const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "dist",
  "build",
  "coverage",
  "vendor",
]);
