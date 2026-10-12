import { defineConfig } from "vitest/config";

// Only this tree's tests: agent worktrees under .claude/worktrees carry their own copies.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], exclude: ["**/node_modules/**", ".claude/**"] } });
