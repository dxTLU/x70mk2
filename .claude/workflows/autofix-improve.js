export const meta = {
  name: 'autofix-improve',
  description: 'Find, adversarially verify, and fix bugs across the codebase, then propose structure improvements',
  whenToUse: 'Run (or /loop) to continuously hunt real bugs, produce test-validated fixes, and surface ranked refactors. One thorough pass per invocation; re-invoke for indefinite operation.',
  phases: [
    { title: 'Find', detail: 'multi-lens finders per subsystem, looping rounds until dry' },
    { title: 'Verify', detail: 'adversarial skeptics kill false positives' },
    { title: 'Fix', detail: 'one worktree per file: minimal patch + scoped tests' },
    { title: 'Structure', detail: 'ranked refactor suggestions (not auto-applied)' },
  ],
}

// ---- configuration (overridable via args) -------------------------------------------------------
const DEFAULTS = {
  // Each subsystem is a cohesive set of files one finder can hold in context at once.
  subsystems: [
    { name: 'rewrite-html', area: 'root', files: ['src/rewrite-html.js'] },
    { name: 'rewrite-js', area: 'root', files: ['src/rewrite-js.js'] },
    { name: 'rewrite-css', area: 'root', files: ['src/rewrite-css.js'] },
    { name: 'proxy-core', area: 'root', files: ['src/proxy.js'] },
    { name: 'cookies', area: 'root', files: ['src/cookies.js'] },
    { name: 'upstream+browser', area: 'root', files: ['src/upstream.js', 'src/browser.js'] },
    { name: 'server+ws+misc', area: 'root', files: ['server.js', 'src/websocket.js', 'src/pages.js', 'src/config.js', 'src/urls.js'] },
    { name: 'client-runtime', area: 'root', files: ['public/client.js'] },
    { name: 'scratch-bridge-net', area: 'scratch', files: ['scratch/bridge/server.js', 'scratch/bridge/ws.js', 'scratch/bridge/sandbox.js'] },
    { name: 'scratch-bridge-data', area: 'scratch', files: ['scratch/bridge/rpc.js', 'scratch/bridge/redis.js', 'scratch/bridge/sql.js', 'scratch/bridge/config.js'] },
    { name: 'scratch-tools+ext', area: 'scratch', files: ['scratch/tools/build.js', 'scratch/tools/twconfig.js', 'scratch/tools/watch.js', 'scratch/tools/setup.js', 'scratch/extension/x70bridge.js'] },
  ],
  // Suites that pass without external daemons (varnishd / playwright are absent here).
  rootTest: "node --test test/cookies.test.js test/rewrite-css.test.js test/rewrite-html.test.js test/rewrite-js.test.js test/proxy.test.js test/server-http.test.js test/server-security.test.js test/server-isolation.test.js test/server-lifecycle.test.js test/server-websocket.test.js test/server-tunnel.test.js test/browser.test.js",
  scratchTest: "cd scratch && node --disable-warning=ExperimentalWarning --test test/*.test.js",
  maxRounds: 3,
}

const cfg = { ...DEFAULTS, ...(args || {}) }
const SUBS = cfg.subsystems
const testCmdFor = (area) => (area === 'scratch' ? cfg.scratchTest : cfg.rootTest)

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'exact repo-relative path from the provided file list' },
          line: { type: 'number', description: '1-indexed line the bug anchors to; 0 if unknown' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          kind: { type: 'string', description: 'correctness | security | resource-leak | concurrency | error-handling | data-loss | api-contract' },
          title: { type: 'string', description: 'one-line claim, no rationale' },
          detail: { type: 'string', description: 'the defect and why it is wrong' },
          repro: { type: 'string', description: 'concrete inputs/state -> wrong output, or the code path a real caller takes' },
          fix: { type: 'string', description: 'the minimal change that fixes it' },
        },
        required: ['file', 'line', 'severity', 'kind', 'title', 'detail', 'repro', 'fix'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    real: { type: 'boolean', description: 'true only if a realistic caller/input actually triggers the defect' },
    reason: { type: 'string', description: 'the path you traced, or why it cannot happen' },
  },
  required: ['real', 'reason'],
}

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    changed: { type: 'boolean', description: 'true if you edited the file' },
    diff: { type: 'string', description: 'exact output of `git diff` for your change (empty if changed=false)' },
    testsPass: { type: 'boolean', description: 'true if the scoped test command passed after your change' },
    testOutput: { type: 'string', description: 'the tail of the test output (pass/fail counts)' },
    summary: { type: 'string', description: 'what you changed and why, or why you made no change' },
  },
  required: ['changed', 'testsPass', 'summary'],
}

const STRUCTURE_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          kind: { type: 'string', description: 'dead-code | duplication | naming | module-boundary | missing-test | simplification | docs' },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          value: { type: 'string', enum: ['low', 'medium', 'high'] },
          title: { type: 'string' },
          detail: { type: 'string', description: 'what to change and the concrete benefit; behavior must stay identical' },
        },
        required: ['file', 'kind', 'risk', 'value', 'title', 'detail'],
      },
    },
  },
  required: ['suggestions'],
}

const LENSES = [
  'correctness & edge cases (off-by-one, wrong operator, missing return, bad default, type coercion, unhandled branch)',
  'security (injection, path/prototype traversal, SSRF, auth/token checks, origin/host validation, unsafe parsing, ReDoS)',
  'robustness (unhandled promise rejection, resource/socket/file-handle leaks, race conditions, error swallowing, unbounded growth)',
]

const key = (f) => `${(f.file || '').toLowerCase()}|${(f.title || '').toLowerCase().replace(/\s+/g, ' ').trim()}`

function finderPrompt(sub, round, lens) {
  return [
    `You are auditing the "${sub.name}" subsystem of this repository for REAL, actionable bugs.`,
    `Read these files in full and trace the code paths: ${sub.files.join(', ')}.`,
    `This is scan round ${round}. Focus lens for this pass: ${lens}.`,
    `Report ONLY genuine defects a real caller or input can trigger — not style, not hypothetical misuse, not "could add a check".`,
    `For each, give the exact file path (from the list above), the line, a concrete repro path, and the minimal fix.`,
    `If you find nothing real under this lens, return an empty findings array. Do not pad.`,
    `Do not modify any files. This is read-only analysis.`,
  ].join('\n')
}

// ---- find + verify, looping rounds until no fresh confirmed bugs --------------------------------
const seen = new Set()
const confirmed = []
let rejectedCount = 0

for (let round = 1; round <= cfg.maxRounds; round++) {
  phase('Find')
  log(`Round ${round}: ${SUBS.length} subsystems x ${LENSES.length} lenses`)

  // Each subsystem scanned under every lens; a barrier so we can dedup the whole round at once.
  const findTasks = []
  for (let s = 0; s < SUBS.length; s++) {
    for (let l = 0; l < LENSES.length; l++) {
      findTasks.push(() => agent(finderPrompt(SUBS[s], round, LENSES[l]), {
        label: `find:${SUBS[s].name}:L${l + 1}:r${round}`,
        phase: 'Find',
        schema: FINDINGS_SCHEMA,
      }))
    }
  }
  const found = (await parallel(findTasks)).filter(Boolean).flatMap((r) => r.findings || [])
  const fresh = found.filter((f) => f.file && !seen.has(key(f)))
  // Dedup within the round too (two lenses can surface the same defect).
  const uniqueFresh = []
  for (const f of fresh) {
    if (seen.has(key(f))) continue
    seen.add(key(f))
    uniqueFresh.push(f)
  }
  log(`Round ${round}: ${found.length} raw, ${uniqueFresh.length} fresh after dedup`)
  if (!uniqueFresh.length) { log(`Round ${round} dry — stopping discovery.`); break }

  phase('Verify')
  // Perspective-diverse adversarial verification: 3 skeptics, distinct lenses, majority rules.
  const verifyLenses = [
    'Try to REPRODUCE it: name the exact caller, input, or sequence that triggers it. If you cannot, it is not real.',
    'Attack the CLAIM: is the described behavior actually wrong, or is it intended / already handled elsewhere in the file?',
    'Check SCOPE & fix: does the defect occur on a path real users/tests hit, and is the proposed fix correct and minimal?',
  ]
  const verdicts = await parallel(uniqueFresh.map((f) => () =>
    parallel(verifyLenses.map((vl, i) => () =>
      agent([
        `Adversarially verify this reported bug. Default to real=false if uncertain.`,
        `File: ${f.file}:${f.line}  [${f.severity}/${f.kind}]`,
        `Claim: ${f.title}`,
        `Detail: ${f.detail}`,
        `Reported repro: ${f.repro}`,
        ``,
        `Your verification lens: ${vl}`,
        `Read the actual file to check. Do not modify anything.`,
      ].join('\n'), { label: `verify:${f.file.split('/').pop()}:v${i + 1}`, phase: 'Verify', schema: VERDICT_SCHEMA })))
      .then((vs) => {
        const votes = vs.filter(Boolean)
        const real = votes.filter((v) => v.real).length >= 2
        return { finding: f, real, votes }
      })))
  const survivors = verdicts.filter(Boolean).filter((v) => v.real).map((v) => v.finding)
  rejectedCount += verdicts.filter(Boolean).filter((v) => !v.real).length
  log(`Round ${round}: ${survivors.length}/${uniqueFresh.length} confirmed after adversarial verify`)
  confirmed.push(...survivors)
  if (!survivors.length) { log(`Round ${round}: no survivors — stopping discovery.`); break }
}

// ---- fix: group confirmed bugs by file, one isolated worktree each ------------------------------
phase('Fix')
const byFile = new Map()
for (const f of confirmed) {
  if (!byFile.has(f.file)) byFile.set(f.file, [])
  byFile.get(f.file).push(f)
}
log(`${confirmed.length} confirmed bugs across ${byFile.size} files — fixing in isolated worktrees`)

const fileAreas = Object.fromEntries(SUBS.flatMap((s) => s.files.map((f) => [f, s.area])))
const fixes = await parallel([...byFile.entries()].map(([file, bugs]) => () => {
  const area = fileAreas[file] || 'root'
  const test = testCmdFor(area)
  return agent([
    `Fix exactly these confirmed bug(s) in ${file}. Make the SMALLEST change that correctly fixes each.`,
    `Do NOT refactor, rename, reformat, or fix anything not listed. Match the surrounding code style.`,
    ``,
    ...bugs.map((b, i) => `Bug ${i + 1} [${b.severity}/${b.kind}] line ${b.line}: ${b.title}\n  ${b.detail}\n  Suggested fix: ${b.fix}`),
    ``,
    `After editing, run this test command from the repo root and confirm it still passes:`,
    `  ${test}`,
    `If a test fails because of your change, fix your change until the suite passes; if a listed bug turns out not to be real on closer reading, leave that one and say so.`,
    `Then run \`git diff -- ${file}\` and return its exact output as "diff", with testsPass and a summary.`,
  ].join('\n'), {
    label: `fix:${file.split('/').pop()}`,
    phase: 'Fix',
    schema: FIX_SCHEMA,
    isolation: 'worktree',
    effort: 'high',
  }).then((r) => ({ file, bugs, ...r }))
}))

// ---- structure: ranked suggestions, NOT auto-applied --------------------------------------------
phase('Structure')
const structure = (await parallel(SUBS.map((sub) => () =>
  agent([
    `Review the "${sub.name}" subsystem for STRUCTURE and maintainability improvements that preserve behavior exactly.`,
    `Files: ${sub.files.join(', ')}.`,
    `Look for: dead/unreachable code, real duplication worth extracting, misleading names, leaky module boundaries,`,
    `missing test coverage for important paths, and safe simplifications. Judge each by risk (chance of breaking behavior)`,
    `and value. Be concrete and conservative — skip cosmetic nits. Do not modify files.`,
  ].join('\n'), { label: `structure:${sub.name}`, phase: 'Structure', schema: STRUCTURE_SCHEMA })))
).filter(Boolean).flatMap((r) => r.suggestions || [])

const sevRank = { critical: 0, high: 1, medium: 2, low: 3 }
confirmed.sort((a, b) => (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9))
const valRank = { high: 0, medium: 1, low: 2 }
structure.sort((a, b) => (valRank[a.value] - valRank[b.value]) || (valRank[a.risk] - valRank[b.risk]))

return {
  confirmedBugs: confirmed,
  rejectedCount,
  fixes: fixes.filter(Boolean),
  structure,
  summary: {
    confirmed: confirmed.length,
    rejected: rejectedCount,
    filesFixed: fixes.filter(Boolean).filter((f) => f.changed && f.testsPass).length,
    fixAttempts: byFile.size,
    structureSuggestions: structure.length,
  },
}
