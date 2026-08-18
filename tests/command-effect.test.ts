import { describe, expect, test } from "bun:test";

import { READ_ONLY_COMMAND_RULES } from "../src/harness/command-effect/rules.ts";
import { shellCommandIsReadOnly } from "../src/harness/command-effect/shell.ts";

function expectCommands(commands: readonly string[], readOnly: boolean): void {
  for (const command of commands) {
    expect({ command, readOnly: shellCommandIsReadOnly(command, READ_ONLY_COMMAND_RULES) })
      .toEqual({ command, readOnly });
  }
}

describe("shell command read effects", () => {
  test("accepts registered read-only Git queries and formatters", () => {
    expectCommands([
      "git status",
      "git status --short --branch",
      "git log --oneline --decorate -12",
      "git show --stat HEAD",
      "git branch --show-current",
      "git branch --list 'feat/*'",
      "git remote -v",
      "git ls-remote origin refs/tags/v0.3.26 refs/heads/main",
      "git tag",
      "git tag --list 'v1.*'",
      "git tag --contains HEAD 'v1.*'",
      "git tag --sort=-version:refname",
      "git status --short --branch && git log --oneline --decorate -12"
        + " && git tag --sort=-version:refname | head -20",
      "/usr/bin/git status | /usr/bin/head -20",
      "git rev-list --left-right --count HEAD...origin/main",
      "git for-each-ref refs/tags --sort=-creatordate --format='%(refname:short)' | head -20",
      "git diff --dirstat=files,0 HEAD~1..HEAD | sort -rn | head -35",
      "git diff --check origin/main...HEAD && git diff --stat origin/main...HEAD",
      "git cherry -v origin/main HEAD",
      "git grep -n \"credentials-local\\|id: credentials\" origin/main -- src | head -100",
      "git rev-parse origin/main v0.3.27",
    ], true);
  });

  test("accepts the session's structured read compositions", () => {
    expectCommands([
      "find . -type f 2>/dev/null && rg -n commandActions src",
      "for c in 28fcda2751 219d2a1fb9; do git show --no-patch --format='%H%n%s' \"$c\"; done",
      "gh release list --repo compforge/baton --limit 10",
      "gh release view v0.3.27 --repo compforge/baton --json name,tagName,url",
    ], true);
  });

  test("accepts npm registry queries used by release preparation", () => {
    expectCommands([
      "npm whoami",
      "npm --cache /private/tmp/baton-npm-cache whoami",
      "npm view @compforge/baton version",
      "npm --cache=/private/tmp/baton-npm-cache view @compforge/baton@0.3.28 version",
    ], true);
  });

  test("accepts ripgrep and the narrow sed print subset", () => {
    expectCommands([
      "rg --files",
      "rg -n commandActions src tests",
      "sed -n '1,240p' AGENTS.md",
      "sed -n -e '1,80p' src/a.ts",
      "sed -n '1,240p' AGENTS.md && sed -n '1,220p' README.md",
    ], true);
  });

  test("accepts find queries without effectful actions", () => {
    expectCommands([
      "find . -maxdepth 3 -name AGENTS.md -print",
      "find src tests -type f",
      "find . -type f -print0",
    ], true);
  });

  test("rejects mutations and effectful query options", () => {
    expectCommands([
      "git tag v1.2.3",
      "git tag -a v1.2.3",
      "git tag -d v1.2.3",
      "git tag --delete v1.2.3",
      "git tag -f v1.2.3",
      "git tag --list v1.2.3 -d",
      "git log --output=/tmp/log",
      "git log --output /tmp/log",
      "git log --ext-diff",
      "git log --textconv",
      "git show --output=/tmp/show HEAD",
      "git show --ext-diff HEAD",
      "git grep --open-files-in-pager pattern",
      "git grep -Ovim pattern",
      "git grep --textconv pattern",
      "git branch feat/new",
      "git branch -d old",
      "git branch --list --sort=-committerdate",
      "git remote add origin example.com/repo.git",
      "git remote set-url origin example.com/repo.git",
      "git ls-remote --upload-pack=helper origin",
      "find . -delete",
      "find . -exec rm {} +",
      "find . -execdir touch marker {} +",
      "find . -ok rm {} +",
      "find . -fprint output.txt",
      "find . -fprintf output.txt '%p\\n'",
      "rg --pre processor pattern",
      "rg --hostname-bin=hostname pattern",
      "sed -i '' '1,2p' file",
      "sed -n '1,2w output' file",
      "sed -n -e '1,2p' -e '3w output' file",
      "sed -n '1,2p' -i file",
      "sort -o output.txt input.txt",
      "sort --output=output.txt input.txt",
      "sort --compress-program=gzip input.txt",
      "gh release delete v1.2.3",
      "gh release view v1.2.3 --web",
      "npm publish --access public",
      "npm install",
      "npm login --auth-type=web",
      "npm config set registry https://registry.example.com",
      "npm --cache view",
    ], false);
  });

  test("fails closed for unsupported commands and shell syntax", () => {
    expectCommands([
      "",
      "cargo test",
      "git branch",
      "git status && rm victim.txt",
      "git status $(rm victim.txt)",
      "git show \"$REV\"",
      "GIT_EXTERNAL_DIFF=helper git diff HEAD~1",
      "git status > /tmp/status",
      "git status 2>/tmp/status",
      "git status & touch victim.txt",
      "git status \\ && git log -1",
      "git status ||",
      "git tag --list 'unterminated",
      "for c in $(touch victim.txt); do git show \"$c\"; done",
    ], false);
  });

  test("keeps command semantics extensible through the registry", () => {
    const rules = new Map(READ_ONLY_COMMAND_RULES);
    rules.set("demo-reader", (args) => args.length === 1 && args[0] === "--safe");

    expect(shellCommandIsReadOnly("demo-reader --safe | head -1", rules)).toBe(true);
    expect(shellCommandIsReadOnly("demo-reader --write", rules)).toBe(false);
  });
});
