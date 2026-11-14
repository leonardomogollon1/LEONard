// tests/skill-router-robustness.test.mjs — router rules that keep pasted JDs,
// market directories, roots and delegated workers working as documented.
//
// Each check pins one fix to .agents/skills/career-ops/SKILL.md:
// - routing reads the whole input ($ARGUMENTS), not a named argument that
//   holds only the first word, and the sub-command is that exact first word;
// - a JD pasted in Spanish or Portuguese is detected like an English one;
// - a market directory's own file names (AGENTS.md → Language Modes) exist
//   and the router is told to look them up;
// - CAREER_OPS_ROOT is described as the data folder and the install lookup
//   checks CAREER_OPS_CODE_ROOT first;
// - delegated workers carry the Untrusted External Content section;
// - the installer's prerequisites match scaffolder/bin/cli.mjs (Node.js, git).
//
// HERMETIC: reads repository files only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const skill = read('.agents/skills/career-ops/SKILL.md');
const body = skill.replace(/^---\n[\s\S]*?\n---\n/, '');

test('routing reads the whole input and matches the sub-command exactly', () => {
  assert.doesNotMatch(body, /\$mode\b/, 'the body still routes on $mode, which holds only the first word');
  assert.match(body, /Determine the mode from the invocation input, `\$ARGUMENTS`/);
  assert.match(body, /The sub-command is the input's first word, matched exactly/);
});

test('a JD in Spanish or Portuguese triggers auto-pipeline', () => {
  const rule = body.match(/\*\*Auto-pipeline detection:\*\*[^\n]*/)?.[0] ?? '';
  assert.ok(rule, 'no auto-pipeline detection rule');
  for (const signal of ['responsibilities', 'requisitos', 'responsabilidades', 'qué buscamos', 'atribuições', 'o que buscamos']) {
    assert.ok(rule.includes(signal), `auto-pipeline detection does not list "${signal}"`);
  }
  assert.match(rule, /in any language/);
});

test('every market file named in AGENTS.md → Language Modes exists, and the router looks them up', () => {
  const section = read('AGENTS.md').split('### Language Modes')[1]?.split('\n### ')[0] ?? '';
  const rows = [...section.matchAll(/^\|[^|]+\|\s*`(modes\/[^`]+)\/`\s*\|\s*`([^`]+)`\s*\/\s*`([^`]+)`\s*\|/gm)];
  assert.ok(rows.length >= 10, `could not read the Language Modes table (${rows.length} rows)`);
  for (const [, dir, evaluation, apply] of rows) {
    for (const name of [evaluation, apply]) {
      assert.ok(existsSync(join(ROOT, dir, `${name}.md`)), `${dir}/${name}.md is named in AGENTS.md but does not exist`);
    }
  }
  assert.match(body, /look it up in `AGENTS\.md` → \*\*Language Modes\*\*/);
  assert.ok(body.includes('`modes/pt/aplicar.md` for `apply`'), 'the router gives no localized apply example');
});

test('roots: CAREER_OPS_ROOT is the data folder; the install lookup checks CAREER_OPS_CODE_ROOT first', () => {
  assert.match(body, /When both are set, `CAREER_OPS_ROOT` wins\. Both name the user's data folder, not the career-ops code\./);
  const lookup = body.match(/^1\. Look for an existing install[^\n]*/m)?.[0] ?? '';
  const code = lookup.indexOf('CAREER_OPS_CODE_ROOT');
  const data = lookup.indexOf('CAREER_OPS_ROOT`');
  assert.ok(code >= 0 && data > code, 'the install lookup must check CAREER_OPS_CODE_ROOT before CAREER_OPS_ROOT');
  const resolver = read('path-resolver.mjs');
  assert.match(resolver, /process\.env\.CAREER_OPS_ROOT\?\.trim\(\) \|\| process\.env\.CAREER_OPS_DATA_DIR\?\.trim\(\)/,
    'path-resolver.mjs no longer gives CAREER_OPS_ROOT precedence; update the router text');
});

test('delegated workers carry the Untrusted External Content section', () => {
  const agentCall = body.match(/```python\nAgent\([\s\S]*?\n\)\n```/)?.[0] ?? '';
  assert.ok(agentCall, 'no worker prompt template');
  assert.ok(agentCall.includes('Untrusted External Content'), 'the worker prompt template omits the untrusted-content rules');
  assert.ok(read('AGENTS.md').includes('## Untrusted External Content'), 'AGENTS.md lost the section the workers are given');
});

test('the installer prerequisites match the scaffolder', () => {
  const cli = read('scaffolder/bin/cli.mjs');
  assert.match(cli, /has\("git"\)/, 'the scaffolder no longer requires git; update the router text');
  assert.match(body, /It needs Node\.js and git/);
});

test('context loading reads config/profile.yml before resolving any mode path', () => {
  assert.match(body, /before choosing any file below, read `config\/profile\.yml` from `DATA_ROOT` if it exists/);
  assert.match(body, /this read is never skipped/);
});
