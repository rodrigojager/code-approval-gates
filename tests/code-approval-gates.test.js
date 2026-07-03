"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  parseArgs,
  detectExecutionMode,
  resolveScopeFiles,
  matchesPattern,
  buildEquivalentCommand,
  buildBaselineSourceScanArgs,
  buildElevatedDoctorCommand,
  readObjective,
  normalizedOptions,
  helpFor,
  runCodeApprovalGates
} = require("../bin/code-approval-gates.js");

const CLI = path.resolve(__dirname, "..", "bin", "code-approval-gates.js");

async function captureStdout(callback) {
  let stdout = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk, encoding, done) => {
    stdout += String(chunk);
    if (typeof encoding === "function") encoding();
    if (typeof done === "function") done();
    return true;
  };

  try {
    const code = await callback();
    return { code, stdout };
  } finally {
    process.stdout.write = originalWrite;
  }
}

test("parseArgs supports unified scope, paths, ignores, and headless flags", () => {
  const parsed = parseArgs([
    "run",
    "--scope",
    "paths",
    "--path",
    "apps/web",
    "--path=docs",
    "--exclude",
    "generated/**",
    "--include",
    "generated/schema.json",
    "--ignore-file",
    ".custom.ignore",
    "--report-output",
    ".quality/reports/baseline-source",
    "--report-dir",
    ".quality/reports/latest",
    "--refresh",
    "--json",
    "--no-interactive",
    "--no-semantic",
    "--no-quality",
    "--no-start-docker",
    "--docker-start-timeout-ms",
    "5000",
    "--fix-network",
    "--codex-sandbox",
    "danger-full-access",
    "--no-codex-bypass-sandbox",
    "--codex-skip-git-repo-check"
  ]);

  assert.equal(parsed.command, "run");
  assert.equal(parsed.options.scope, "paths");
  assert.deepEqual(parsed.options.paths, ["apps/web", "docs"]);
  assert.deepEqual(parsed.options.excludes, ["generated/**"]);
  assert.deepEqual(parsed.options.includes, ["generated/schema.json"]);
  assert.deepEqual(parsed.options.ignoreFiles, [".custom.ignore"]);
  assert.equal(parsed.options.reportOutput, ".quality/reports/baseline-source");
  assert.equal(parsed.options.reportDir, ".quality/reports/latest");
  assert.equal(parsed.options.refresh, true);
  assert.equal(parsed.options.json, true);
  assert.equal(parsed.options.noInteractive, true);
  assert.equal(parsed.options.semantic, false);
  assert.equal(parsed.options.quality, false);
  assert.equal(parsed.options.noStartDocker, true);
  assert.equal(parsed.options.dockerStartTimeoutMs, 5000);
  assert.equal(parsed.options.fixNetwork, true);
  assert.equal(parsed.options.codexSandbox, "danger-full-access");
  assert.equal(parsed.options.codexBypassSandbox, false);
  assert.equal(parsed.options.codexSkipGitRepoCheck, true);
  assert.equal(parsed.options.passthrough.includes("--refresh"), false);
  assert.equal(parsed.options.passthrough.includes("--json"), false);
  assert.equal(parsed.options.passthrough.includes("--no-interactive"), false);
  assert.equal(parsed.options.passthrough.includes("--no-start-docker"), false);
  assert.equal(parsed.options.passthrough.includes("--fix-network"), false);

  const globalFirst = parseArgs(["--cwd", "repo", "run", "--scope", "full", "--json"]);
  assert.equal(globalFirst.command, "run");
  assert.equal(globalFirst.options.cwd, "repo");
  assert.equal(globalFirst.options.scope, "full");
  assert.equal(globalFirst.options.json, true);
});

test("detectExecutionMode makes json and ci headless", () => {
  assert.equal(detectExecutionMode({ json: true }).headless, true);
  assert.equal(detectExecutionMode({ ci: true }).headless, true);
  assert.equal(detectExecutionMode({ json: true }).interactive, false);
  assert.equal(detectExecutionMode({ json: true, interactive: true }).interactive, false);
  assert.equal(detectExecutionMode({ ci: true, interactive: true }).interactive, false);
  assert.equal(detectExecutionMode({ noInteractive: true, interactive: true }).interactive, false);
});

test("root json headless without command returns structured error", async () => {
  const result = await captureStdout(() => runCodeApprovalGates(["--json", "--no-interactive"]));
  const payload = JSON.parse(result.stdout);

  assert.equal(result.code, 2);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.status, "ERROR");
  assert.equal(payload.code, "MISSING_COMMAND");
  assert.equal(payload.error.code, "MISSING_COMMAND");
  assert.equal(payload.exitCode, 2);
});

test("help respects json output mode", async () => {
  const result = await captureStdout(() => runCodeApprovalGates(["help", "run", "--json", "--no-interactive"]));
  const payload = JSON.parse(result.stdout);

  assert.equal(result.code, 0);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.command, "run");
  assert.match(payload.help, /code-approval-gates run/);
  assert.deepEqual(payload.scopes, ["changed", "full", "paths"]);
  assert.ok(payload.headlessFlags.includes("--no-interactive"));
  assert.ok(payload.commands.includes("baseline create"));
  assert.equal(payload.scoreAppliesTo.changed, "changed-files");
  assert.equal(payload.errorShape.status, "ERROR");
  assert.equal(payload.errorShape.error.code, "ERROR_CODE");
  assert.equal(payload.errorShape.exitCode, 2);
  assert.equal(payload.wizard.actions.join(","), "run,quality,semantic,baseline,report,config,doctor");
  assert.deepEqual(payload.wizard.runGates, ["both", "quality", "semantic"]);

  const subcommand = await captureStdout(() => runCodeApprovalGates(["baseline", "create", "--help", "--json", "--no-interactive"]));
  const subcommandPayload = JSON.parse(subcommand.stdout);

  assert.equal(subcommand.code, 0);
  assert.equal(subcommandPayload.schemaVersion, 1);
  assert.equal(subcommandPayload.command, "baseline create");
  assert.match(subcommandPayload.help, /code-approval-gates baseline/);
});

test("auxiliary commands keep json output machine-readable", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "code-approval-headless-"));
  try {
    const reportPath = await captureStdout(() => runCodeApprovalGates([
      "--cwd",
      temp,
      "report",
      "path",
      "--json",
      "--no-interactive"
    ]));
    assert.equal(reportPath.code, 0);
    assert.match(JSON.parse(reportPath.stdout).reportPath, /summary\.json$/);

    const unknownReport = await captureStdout(() => runCodeApprovalGates([
      "report",
      "missing",
      "--cwd",
      temp,
      "--json",
      "--no-interactive"
    ]));
    assert.equal(unknownReport.code, 2);
    const unknownReportPayload = JSON.parse(unknownReport.stdout);
    assert.equal(unknownReportPayload.schemaVersion, 1);
    assert.equal(unknownReportPayload.code, "UNKNOWN_REPORT_COMMAND");
    assert.equal(unknownReportPayload.error.code, "UNKNOWN_REPORT_COMMAND");
    assert.equal(unknownReportPayload.exitCode, 2);

    const unknownConfig = await captureStdout(() => runCodeApprovalGates([
      "config",
      "missing",
      "--cwd",
      temp,
      "--json",
      "--no-interactive"
    ]));
    assert.equal(unknownConfig.code, 2);
    const unknownConfigPayload = JSON.parse(unknownConfig.stdout);
    assert.equal(unknownConfigPayload.schemaVersion, 1);
    assert.equal(unknownConfigPayload.code, "UNKNOWN_CONFIG_COMMAND");
    assert.equal(unknownConfigPayload.error.code, "UNKNOWN_CONFIG_COMMAND");
    assert.equal(unknownConfigPayload.exitCode, 2);

    const unknownBaseline = await captureStdout(() => runCodeApprovalGates([
      "baseline",
      "missing",
      "--cwd",
      temp,
      "--json",
      "--no-interactive"
    ]));
    assert.equal(unknownBaseline.code, 2);
    const unknownBaselinePayload = JSON.parse(unknownBaseline.stdout);
    assert.equal(unknownBaselinePayload.schemaVersion, 1);
    assert.equal(unknownBaselinePayload.code, "UNKNOWN_BASELINE_COMMAND");
    assert.equal(unknownBaselinePayload.error.code, "UNKNOWN_BASELINE_COMMAND");
    assert.equal(unknownBaselinePayload.exitCode, 2);

    const unknownDoctor = await captureStdout(() => runCodeApprovalGates([
      "doctor",
      "missing",
      "--cwd",
      temp,
      "--json",
      "--no-interactive"
    ]));
    assert.equal(unknownDoctor.code, 2);
    const unknownDoctorPayload = JSON.parse(unknownDoctor.stdout);
    assert.equal(unknownDoctorPayload.schemaVersion, 1);
    assert.equal(unknownDoctorPayload.code, "UNKNOWN_DOCTOR_FOCUS");
    assert.equal(unknownDoctorPayload.error.code, "UNKNOWN_DOCTOR_FOCUS");
    assert.equal(unknownDoctorPayload.exitCode, 2);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("parseArgs keeps operational boolean flags out of passthrough", () => {
  const parsed = parseArgs([
    "semantic",
    "--objective-stdin",
    "--interactive",
    "--non-blocking",
    "--fix",
    "--fix-network",
    "--elevated-child",
    "--yes",
    "--install-global"
  ]);

  assert.equal(parsed.options.objectiveStdin, true);
  assert.equal(parsed.options.interactive, true);
  assert.equal(parsed.options.nonBlocking, true);
  assert.equal(parsed.options.fix, true);
  assert.equal(parsed.options.fixNetwork, true);
  assert.equal(parsed.options.elevatedChild, true);
  assert.equal(parsed.options.yes, true);
  assert.equal(parsed.options.installGlobal, true);
  assert.equal(parsed.options.passthrough.includes("--objective-stdin"), false);
  assert.equal(parsed.options.passthrough.includes("--non-blocking"), false);
  assert.equal(parsed.options.passthrough.includes("--fix-network"), false);
  assert.equal(parsed.options.passthrough.includes("--elevated-child"), false);
  assert.equal(parsed.options.passthrough.includes("--yes"), false);
  assert.equal(parsed.options.passthrough.includes("--install-global"), false);
});

test("normalizedOptions merges config defaults with command-line filters", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "code-approval-normalized-"));
  try {
    fs.writeFileSync(path.join(temp, ".code-approval-gates.json"), JSON.stringify({
      defaultScope: "paths",
      paths: ["docs"],
      excludes: ["generated/**"],
      includes: ["generated/schema.json"],
      ignoreFiles: [".team.ignore"]
    }), "utf8");

    const options = normalizedOptions(temp, {
      excludes: ["tmp/**"],
      includes: ["tmp/keep.json"],
      ignoreFiles: [".local.ignore"]
    });

    assert.equal(options.scope, "paths");
    assert.deepEqual(options.paths, ["docs"]);
    assert.deepEqual(options.excludes, ["generated/**", "tmp/**"]);
    assert.deepEqual(options.includes, ["generated/schema.json", "tmp/keep.json"]);
    assert.deepEqual(options.ignoreFiles, [".team.ignore", ".local.ignore"]);

    const overridePaths = normalizedOptions(temp, {
      paths: ["src"]
    });

    assert.deepEqual(overridePaths.paths, ["src"]);

    const changedScope = normalizedOptions(temp, {
      scope: "changed"
    });

    assert.deepEqual(changedScope.paths, []);

    const qualityGate = normalizedOptions(temp, {
      gate: "quality"
    });

    assert.equal(qualityGate.quality, true);
    assert.equal(qualityGate.semantic, false);

    const semanticGate = normalizedOptions(temp, {
      gate: "semantic"
    });

    assert.equal(semanticGate.quality, false);
    assert.equal(semanticGate.semantic, true);

    assert.throws(() => normalizedOptions(temp, {
      gate: "invalid"
    }), /--gate must be quality, semantic, or both/);

    assert.throws(() => normalizedOptions(temp, {
      scope: "changed",
      paths: ["docs"]
    }), /--path can only be used with --scope paths/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("readObjective resolves objective files relative to analysis cwd", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "code-approval-objective-"));
  try {
    fs.mkdirSync(path.join(temp, ".quality"), { recursive: true });
    fs.writeFileSync(path.join(temp, ".quality", "objective.md"), "Review from cwd\n", "utf8");

    assert.equal(readObjective({ objectiveFile: ".quality/objective.md" }, temp), "Review from cwd\n");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("buildEquivalentCommand includes baseline subcommand and semantic provider options", () => {
  const baseline = buildEquivalentCommand("baseline", {
    scope: "paths",
    paths: ["src"],
    output: ".quality/reports/latest",
    reportOutput: ".quality/reports/baseline-source",
    threshold: 80,
    format: "json,md"
  });

  assert.match(baseline, /code-approval-gates baseline create/);
  assert.match(baseline, /--scope paths/);
  assert.match(baseline, /--path src/);
  assert.match(baseline, /--output \.quality\/baseline\/baseline\.json/);
  assert.match(baseline, /--report-output/);

  const baselineWithReportOutputFromConfig = buildEquivalentCommand("baseline", {
    scope: "full",
    output: "code-approval-report",
    threshold: 90,
    format: "json,md"
  });

  assert.match(baselineWithReportOutputFromConfig, /--output \.quality\/baseline\/baseline\.json/);

  const baselineWithCustomFile = buildEquivalentCommand("baseline", {
    scope: "full",
    output: ".quality/baseline/custom-baseline",
    reportOutput: ".quality/reports/baseline-source",
    threshold: 90,
    format: "json,md"
  });

  assert.match(baselineWithCustomFile, /--output \.quality\/baseline\/custom-baseline/);

  const semantic = buildEquivalentCommand("semantic", {
    scope: "changed",
    objective: "Review architecture risks",
    provider: "codex-cli",
    model: "gpt-5.5",
    reasoningEffort: "high",
    codexSandbox: "danger-full-access",
    codexBypassSandbox: false,
    codexSkipGitRepoCheck: true,
    json: true,
    noInteractive: true
  });

  assert.match(semantic, /--objective/);
  assert.match(semantic, /Review architecture risks/);
  assert.match(semantic, /--provider codex-cli/);
  assert.match(semantic, /--model gpt-5.5/);
  assert.match(semantic, /--reasoning-effort high/);
  assert.match(semantic, /--codex-sandbox danger-full-access/);
  assert.match(semantic, /--no-codex-bypass-sandbox/);
  assert.match(semantic, /--codex-skip-git-repo-check/);
  assert.match(semantic, /--json/);
  assert.match(semantic, /--no-interactive/);

  const doctor = buildEquivalentCommand("doctor", {
    focus: "semantic",
    fix: true,
    fixNetwork: true,
    yes: true,
    installGlobal: true,
    json: true,
    noInteractive: true
  });

  assert.match(doctor, /code-approval-gates doctor semantic/);
  assert.match(doctor, /--fix/);
  assert.match(doctor, /--fix-network/);
  assert.match(doctor, /--yes/);
  assert.match(doctor, /--install-global/);
  assert.match(doctor, /--json/);
  assert.match(doctor, /--no-interactive/);

  const gatedRun = buildEquivalentCommand("run", {
    gate: "quality",
    scope: "changed",
    threshold: 90,
    format: "json,md"
  });

  assert.match(gatedRun, /--gate quality/);

  const fullRun = buildEquivalentCommand("run", {
    scope: "full",
    paths: ["src"],
    threshold: 90,
    format: "json,md"
  });

  assert.doesNotMatch(fullRun, /--path src/);
});

test("buildBaselineSourceScanArgs propagates source scan options", () => {
  const args = buildBaselineSourceScanArgs({
    scope: "paths",
    output: ".quality/reports/baseline-source",
    threshold: 87,
    provider: "codex-cli",
    model: "gpt-5.5",
    reasoningEffort: "high",
    codexSandbox: "danger-full-access",
    codexBypassSandbox: true,
    codexSkipGitRepoCheck: false,
    objective: "Create release baseline",
    paths: ["src"],
    excludes: ["generated/**"],
    includes: ["generated/schema.json"],
    ignoreFiles: [".custom.ignore"]
  });

  assert.deepEqual(args.slice(1, 4), ["run", "--scope", "paths"]);
  assert.ok(args.includes("--threshold"));
  assert.ok(args.includes("87"));
  assert.ok(args.includes("--provider"));
  assert.ok(args.includes("codex-cli"));
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("gpt-5.5"));
  assert.ok(args.includes("--reasoning-effort"));
  assert.ok(args.includes("high"));
  assert.ok(args.includes("--codex-sandbox"));
  assert.ok(args.includes("danger-full-access"));
  assert.ok(args.includes("--codex-bypass-sandbox"));
  assert.ok(args.includes("--no-codex-skip-git-repo-check"));
  assert.ok(args.includes("--objective"));
  assert.ok(args.includes("Create release baseline"));
  assert.ok(args.includes("--path"));
  assert.ok(args.includes("src"));
  assert.ok(args.includes("--exclude"));
  assert.ok(args.includes("generated/**"));
  assert.ok(args.includes("--include"));
  assert.ok(args.includes("generated/schema.json"));
  assert.ok(args.includes("--ignore-file"));
  assert.ok(args.includes(".custom.ignore"));

  const fullArgs = buildBaselineSourceScanArgs({
    scope: "full",
    paths: ["src"]
  });
  assert.equal(fullArgs.includes("--path"), false);

  const defaultOutputArgs = buildBaselineSourceScanArgs({});
  assert.equal(defaultOutputArgs[defaultOutputArgs.indexOf("--output") + 1], ".quality/reports/baseline-source");

  const noSemanticArgs = buildBaselineSourceScanArgs({
    semantic: false,
    objective: "Should not be passed",
    provider: "codex-cli",
    model: "gpt-5.5",
    objectiveStdin: true
  });

  assert.ok(noSemanticArgs.includes("--no-semantic"));
  assert.equal(noSemanticArgs.includes("--objective"), false);
  assert.equal(noSemanticArgs.includes("--objective-stdin"), false);
  assert.equal(noSemanticArgs.includes("--provider"), false);
  assert.equal(noSemanticArgs.includes("--model"), false);
});

test("buildElevatedDoctorCommand creates a non-recursive elevated network repair command", () => {
  const command = buildElevatedDoctorCommand("C:\\Repo With Spaces", {
    json: true,
    noInteractive: true
  });

  assert.match(command, /doctor semantic --fix-network --yes --elevated-child/);
  assert.match(command, /--cwd "C:\\Repo With Spaces"/);
  assert.match(command, /--json/);
  assert.match(command, /--no-interactive/);
});

test("help text lists all public commands and baseline scope flags", () => {
  const rootHelp = helpFor("root");

  assert.match(rootHelp, /code-approval-gates wizard/);
  assert.match(rootHelp, /code-approval-gates report/);
  assert.match(rootHelp, /code-approval-gates config/);
  assert.match(rootHelp, /code-approval-gates init/);
  assert.match(rootHelp, /code-approval-gates version/);
  assert.match(rootHelp, /code-approval-gates help <command>/);
  assert.match(rootHelp, /--cwd <dir>/);
  assert.match(rootHelp, /--non-blocking/);
  assert.match(rootHelp, /scoreAppliesTo/);
  assert.match(rootHelp, /changed-files, entire-project, or selected-paths/);

  const baselineHelp = helpFor("baseline");

  assert.match(baselineHelp, /In baseline create, --output is the baseline JSON file/);
  assert.match(baselineHelp, /--report-output is the source scan report directory/);
  assert.match(baselineHelp, /--scope changed\|full\|paths/);
  assert.match(baselineHelp, /--path <path>/);
  assert.match(baselineHelp, /--exclude <glob>/);
  assert.match(baselineHelp, /--ignore-file <path>/);
  assert.match(baselineHelp, /--no-semantic/);
  assert.match(baselineHelp, /--no-quality/);
  assert.match(baselineHelp, /At least one gate must remain enabled/);
  assert.match(baselineHelp, /Baseline semantic source scan flags/);
  assert.match(baselineHelp, /--objective <text>/);
  assert.match(baselineHelp, /--provider <name>/);
  assert.match(baselineHelp, /--model <name>/);
  assert.match(helpFor("baseline create"), /code-approval-gates baseline/);
  assert.match(helpFor("baseline check"), /code-approval-gates baseline/);

  const qualityHelp = helpFor("quality");

  assert.match(qualityHelp, /code-approval-gates quality --scope changed --json --no-interactive/);
  assert.match(qualityHelp, /code-approval-gates quality --ci --scope changed[^\n]*--no-interactive/);

  const semanticHelp = helpFor("semantic");

  assert.match(semanticHelp, /--objective <text>/);
  assert.match(semanticHelp, /code-approval-gates semantic --ci --scope changed[^\n]*--no-interactive/);

  const runHelp = helpFor("run");

  assert.match(runHelp, /--gate quality --scope changed/);
  assert.match(runHelp, /--gate semantic --scope changed/);
  assert.match(runHelp, /code-approval-gates run --ci --scope changed[^\n]*--no-interactive/);

  const doctorHelp = helpFor("doctor");

  assert.match(doctorHelp, /installs semantic dependencies when missing/);
  assert.match(doctorHelp, /--fix-network/);
  assert.match(doctorHelp, /api\.openai\.com/);
  assert.match(doctorHelp, /--yes/);
  assert.match(doctorHelp, /Pre-approve fix\/install actions/);
  assert.match(doctorHelp, /code-approval-gates doctor semantic --ci --no-interactive/);
  assert.match(doctorHelp, /Focus values:/);
  assert.match(doctorHelp, /quality, semantic, gitlab/);

  const reportHelp = helpFor("report");

  assert.match(reportHelp, /Reads generated reports/);
  assert.match(reportHelp, /--report-dir <dir>/);
  assert.match(reportHelp, /code-approval-gates report path/);
  assert.match(helpFor("report path"), /Reads generated reports/);

  const configHelp = helpFor("config");

  assert.match(configHelp, /Dot paths are supported/);
  assert.match(configHelp, /config set defaultScope full/);
  assert.match(configHelp, /config set output \.quality\/reports\/latest/);
  assert.match(configHelp, /config set baseline\.path \.quality\/baseline\/baseline\.json/);
  assert.match(configHelp, /config set semantic\.provider codex-cli/);
  assert.match(configHelp, /config set semantic\.model gpt-5\.5/);
  assert.match(configHelp, /Values are parsed as JSON-like scalars/);
  assert.match(configHelp, /Do not store API keys in \.code-approval-gates\.json/);
  assert.match(helpFor("config set"), /Dot paths are supported/);
  assert.match(helpFor("doctor semantic"), /Focus values:/);

  const wizardHelp = helpFor("wizard");

  assert.match(wizardHelp, /excludes\/includes/);
  assert.match(wizardHelp, /extra ignore files/);
  assert.match(wizardHelp, /Doctor fix mode/);
  assert.match(wizardHelp, /interactive TTY/);
  assert.match(wizardHelp, /--no-interactive for automation/);
});

test("agent skills document headless scope ignores and non-blocking behavior", () => {
  const semanticSkill = fs.readFileSync(path.resolve(__dirname, "..", "use-semantic-gate", "SKILL.md"), "utf8");
  const qualitySkill = fs.readFileSync(path.resolve(__dirname, "..", "use-quality-gate", "SKILL.md"), "utf8");
  const packagedQualitySkill = fs.readFileSync(path.resolve(__dirname, "..", "quality-gate", "skill", "quality-gate.md"), "utf8");
  const semanticAgent = fs.readFileSync(path.resolve(__dirname, "..", "use-semantic-gate", "agents", "openai.yaml"), "utf8");
  const qualityAgent = fs.readFileSync(path.resolve(__dirname, "..", "use-quality-gate", "agents", "openai.yaml"), "utf8");

  assert.match(semanticSkill, /code-approval-gates semantic --scope changed/);
  assert.match(semanticSkill, /--objective "Review architecture, quality, and risks"/);
  assert.match(semanticSkill, /\.code-approval-gates\.ignore/);
  assert.match(semanticSkill, /\.semantic-gate\.ignore/);
  assert.match(semanticSkill, /--json --no-interactive/);
  assert.match(semanticSkill, /--ci --no-interactive/);
  assert.match(semanticSkill, /doctor semantic --fix --yes --no-interactive/);
  assert.match(semanticSkill, /scoreAppliesTo/);
  assert.match(semanticSkill, /--non-blocking/);
  assert.match(semanticSkill, /Use `--path` only with `--scope paths`/);
  assert.match(semanticAgent, /code-approval-gates semantic --scope changed --json --no-interactive/);
  assert.match(semanticAgent, /doctor semantic --fix --yes --no-interactive/);
  assert.doesNotMatch(semanticAgent, /Run semantic-gate/);

  assert.match(qualitySkill, /code-approval-gates quality --scope changed/);
  assert.match(qualitySkill, /\.code-approval-gates\.ignore/);
  assert.match(qualitySkill, /\.quality-gate\.ignore/);
  assert.match(qualitySkill, /--json --no-interactive/);
  assert.match(qualitySkill, /--ci --no-interactive/);
  assert.match(qualitySkill, /doctor quality --fix --yes --no-interactive/);
  assert.match(qualitySkill, /scoreAppliesTo/);
  assert.match(qualitySkill, /--non-blocking/);
  assert.match(qualitySkill, /Use `--path` only with `--scope paths`/);
  assert.match(qualityAgent, /code-approval-gates quality --scope changed --json --no-interactive/);
  assert.match(qualityAgent, /doctor quality --fix --yes --no-interactive/);
  assert.doesNotMatch(qualityAgent, /Run quality-check/);
  assert.match(packagedQualitySkill, /code-approval-gates quality --scope changed/);
  assert.match(packagedQualitySkill, /scoreAppliesTo/);
  assert.match(packagedQualitySkill, /doctor quality --fix --yes --no-interactive/);
  assert.doesNotMatch(packagedQualitySkill, /code-approval-gates semantic --scope changed/);
});

test("ci examples keep explicit headless flags", () => {
  const files = [
    path.join("examples", "ci", "gitlab-both-gates.yml"),
    path.join("examples", "ci", "gitlab-quality-gate.yml"),
    path.join("examples", "ci", "gitlab-semantic-gate-codex-cli.yml"),
    path.join("examples", "ci", "github-actions-both-gates.yml"),
    path.join("semantic-gate", "examples", "gitlab-ci.yml")
  ];

  for (const file of files) {
    const content = fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
    assert.equal(/npm (run )?(test|verify)|test:build/.test(content), false, `${file} should run the published CLI, not repo development scripts`);
    if (content.includes("code-approval-gates doctor --ci")) {
      assert.match(content, /code-approval-gates doctor --ci --no-interactive/);
    }
    if (content.includes("code-approval-gates doctor quality --ci")) {
      assert.match(content, /code-approval-gates doctor quality --ci --no-interactive/);
    }
    if (content.includes("code-approval-gates doctor semantic --ci")) {
      assert.match(content, /code-approval-gates doctor semantic --ci --no-interactive/);
    }
    if (content.includes("code-approval-gates doctor gitlab --ci")) {
      assert.match(content, /code-approval-gates doctor gitlab --ci --no-interactive/);
    }
    if (content.includes("code-approval-gates run --ci")) {
      assert.match(content, /code-approval-gates run --ci[^\n]*--no-interactive/);
    }
    if (content.includes("code-approval-gates quality --ci")) {
      assert.match(content, /code-approval-gates quality --ci[^\n]*--no-interactive/);
    }
    if (content.includes("code-approval-gates semantic --ci")) {
      assert.match(content, /code-approval-gates semantic --ci[^\n]*--no-interactive/);
    }
  }
});

test("package metadata and README point users to the unified CLI", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package-lock.json"), "utf8"));
  const semanticPkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "semantic-gate", "package.json"), "utf8"));
  const qualityPkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "quality-gate", "package.json"), "utf8"));
  const verifyScript = fs.readFileSync(path.resolve(__dirname, "..", "scripts", "verify-all.ps1"), "utf8");
  const readme = fs.readFileSync(path.resolve(__dirname, "..", "README.md"), "utf8");
  const qualityReadme = fs.readFileSync(path.resolve(__dirname, "..", "quality-gate", "README.md"), "utf8");
  const semanticReadme = fs.readFileSync(path.resolve(__dirname, "..", "semantic-gate", "README.md"), "utf8");
  const exampleConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", ".code-approval-gates.example.json"), "utf8"));

  assert.match(pkg.description, /Unified Code Approval Gates CLI/);
  assert.deepEqual(lock.packages[""].bin, pkg.bin);
  assert.ok(pkg.keywords.includes("code-approval-gates"));
  assert.ok(pkg.keywords.includes("quality-gate"));
  assert.ok(pkg.keywords.includes("semantic-gate"));
  assert.ok(pkg.files.includes(".code-approval-gates.example.json"));
  assert.ok(pkg.files.includes("tests/"));
  assert.ok(pkg.files.includes("semantic-gate/tests/"));
  assert.ok(pkg.files.includes("quality-gate/tests/"));
  assert.ok(semanticPkg.files.includes("tests/"));
  assert.ok(qualityPkg.files.includes("tests/"));
  assert.equal(semanticPkg.scripts.test, "node --test tests/*.test.js");
  assert.equal(semanticPkg.scripts["test:build"], "npm run build && npm run test");
  assert.equal(pkg.scripts["test:semantic"], "npm --prefix semantic-gate test --workspaces=false");
  assert.equal(pkg.scripts["test:semantic:build"], "npm --prefix semantic-gate run test:build --workspaces=false");
  assert.match(verifyScript, /npm run test:build --workspaces=false/);
  assert.equal(exampleConfig.output, ".quality/reports/latest");
  assert.deepEqual(exampleConfig.paths, []);
  assert.deepEqual(exampleConfig.excludes, []);
  assert.deepEqual(exampleConfig.includes, []);
  assert.deepEqual(exampleConfig.ignoreFiles, []);
  assert.equal(exampleConfig.baseline.path, ".quality/baseline/baseline.json");
  assert.match(readme, /### Binarios diretos avancados/);
  assert.match(readme, /### Advanced direct binaries/);
  assert.match(readme, /prefira `code-approval-gates`/);
  assert.match(readme, /prefer `code-approval-gates`/);
  assert.match(readme, /Para baseline, o wizard sugere `full`/);
  assert.match(readme, /For baseline, the wizard suggests `full`/);
  assert.match(readme, /modo de correcao do Doctor/);
  assert.match(readme, /Doctor fix mode/);
  assert.match(readme, /excludes\/includes temporarios/);
  assert.match(readme, /temporary excludes\/includes/);
  assert.match(readme, /No comando `baseline create`, `--output` aponta para o arquivo JSON do baseline/);
  assert.match(readme, /In `baseline create`, `--output` points to the baseline JSON file/);
  assert.match(readme, /Essas flags semanticas sao ignoradas quando `--no-semantic` e usado/);
  assert.match(readme, /Those semantic flags are ignored when `--no-semantic` is used/);
  assert.match(readme, /!generated\/schema\.json/);
  assert.match(readme, /command-line flags override file configuration/);
  assert.match(readme, /flags da linha de comando sobrescrevem a configuracao/);
  assert.match(readme, /Nao e necessario renomear esse exemplo manualmente/);
  assert.match(readme, /You do not need to rename that example manually/);
  assert.match(readme, /Valores como `true`, `false` e numeros/);
  assert.match(readme, /Values such as `true`, `false`, and numbers/);
  assert.match(readme, /defaults de `paths`, `excludes`, `includes` e `ignoreFiles`/);
  assert.match(readme, /`paths`, `excludes`, `includes`, and `ignoreFiles` defaults/);
  assert.match(readme, /`paths` so e usado quando o escopo efetivo e `paths`/);
  assert.match(readme, /`paths` is used only when the effective scope is `paths`/);
  assert.match(readme, /`--path` exige `--scope paths`/);
  assert.match(readme, /`--path` requires `--scope paths`/);
  assert.match(readme, /`--ci`, `--json` e `--no-interactive` nunca abrem wizard\/TUI/);
  assert.match(readme, /`--ci`, `--json`, and `--no-interactive` never open the wizard\/TUI/);
  assert.match(readme, /code-approval-gates help run --json --no-interactive/);
  assert.match(readme, /npm run verify/);
  assert.match(readme, /Semantic Gate build\/test/);
  assert.match(readme, /Use `npm test` para o conjunto de testes sobre os artefatos ja gerados/);
  assert.match(readme, /Use `npm test` for the test set over already generated artifacts/);
  assert.match(readme, /Em pipelines consumidores, rode `code-approval-gates`/);
  assert.match(readme, /In consumer pipelines, run `code-approval-gates`/);
  assert.match(readme, /nao instala o pacote globalmente, exceto quando `--install-global`/);
  assert.match(readme, /does not install the package globally unless `--install-global`/);
  assert.match(readme, /sem `--yes` pedem confirmacao/);
  assert.match(readme, /without `--yes` ask for confirmation/);
  assert.match(readme, /code-approval-gates doctor --fix --yes/);
  assert.match(readme, /code-approval-gates report summary --report-dir \.quality\/reports\/latest/);
  assert.match(readme, /code-approval-gates run --gate quality --scope changed/);
  assert.match(readme, /code-approval-gates run --gate semantic --scope changed/);
  assert.match(readme, /Todo relatorio declara `scoreAppliesTo`/);
  assert.match(readme, /Every report declares `scoreAppliesTo`/);
  assert.match(readme, /changed-files/);
  assert.match(readme, /entire-project/);
  assert.match(readme, /selected-paths/);
  assert.match(readme, /code-approval-gates baseline create --help/);
  assert.match(readme, /code-approval-gates baseline check --help/);
  assert.match(readme, /code-approval-gates report path --help/);
  assert.match(readme, /code-approval-gates config set --help/);
  assert.match(qualityReadme, /gitignore-style `!path` re-inclusion/);
  assert.match(semanticReadme, /gitignore-style `!path` re-inclusion/);
  assert.match(qualityReadme, /\.gitignore`, `.code-approval-gates\.ignore`, and `.quality-gate\.ignore`/);
  assert.match(semanticReadme, /\.gitignore`, `.code-approval-gates\.ignore`, and `.semantic-gate\.ignore`/);
  assert.match(qualityReadme, /`--path` requires `--scope paths`/);
  assert.match(semanticReadme, /`--path` requires `--scope paths`/);
  assert.match(qualityReadme, /Reports include `scoreAppliesTo`/);
  assert.match(semanticReadme, /Reports include `scoreAppliesTo`/);
  assert.match(qualityReadme, /Prefer `code-approval-gates quality`/);
  assert.match(semanticReadme, /Prefer `code-approval-gates semantic`/);
  assert.match(semanticReadme, /Package tests use the published `dist\/` files/);
  assert.match(semanticReadme, /npm run test:build/);
});

test("matchesPattern handles gitignore-style directory and glob patterns", () => {
  assert.equal(matchesPattern("generated/api/schema.json", "generated/**"), true);
  assert.equal(matchesPattern("src/app.test.js", "*.js"), true);
  assert.equal(matchesPattern("src/app.ts", "*.js"), false);
  assert.equal(matchesPattern("node_modules/pkg/index.js", "node_modules/"), true);
});

test("resolveScopeFiles changed scope uses git changes and ignore files", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "code-approval-gates-root-"));
  try {
    run("git", ["init"], temp);
    fs.mkdirSync(path.join(temp, "src"), { recursive: true });
    fs.writeFileSync(path.join(temp, "src", "app.js"), "const value = 1;\n", "utf8");
    fs.writeFileSync(path.join(temp, "src", "skip.js"), "const skip = true;\n", "utf8");
    fs.writeFileSync(path.join(temp, ".code-approval-gates.ignore"), "src/skip.js\n", "utf8");

    const result = resolveScopeFiles(temp, {
      scope: "changed",
      paths: [],
      excludes: [],
      includes: [],
      ignoreFiles: []
    }, "combined");

    assert.equal(result.scope, "changed");
    assert.ok(result.files.includes("src/app.js"));
    assert.equal(result.files.includes("src/skip.js"), false);
    assert.ok(result.ignoreFiles.includes(".code-approval-gates.ignore"));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("resolveScopeFiles paths scope does not add support files outside selected paths", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "code-approval-paths-scope-"));
  try {
    run("git", ["init"], temp);
    fs.mkdirSync(path.join(temp, "docs"), { recursive: true });
    fs.writeFileSync(path.join(temp, "package.json"), "{\"name\":\"demo\"}\n", "utf8");
    fs.writeFileSync(path.join(temp, "docs", "a.md"), "# A\n", "utf8");

    const result = resolveScopeFiles(temp, {
      scope: "paths",
      paths: ["docs"],
      excludes: [],
      includes: [],
      ignoreFiles: []
    }, "combined");

    assert.deepEqual(result.files, ["docs/a.md"]);
    assert.equal(result.files.includes("package.json"), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("resolveScopeFiles loads gate-specific ignore files without duplicates", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "code-approval-ignore-files-"));
  try {
    run("git", ["init"], temp);
    fs.writeFileSync(path.join(temp, "app.js"), "const value = 1;\n", "utf8");
    fs.writeFileSync(path.join(temp, ".semantic-gate.ignore"), "ignored.js\n", "utf8");
    fs.writeFileSync(path.join(temp, ".quality-gate.ignore"), "ignored.js\n", "utf8");

    const semantic = resolveScopeFiles(temp, {
      scope: "full",
      paths: [],
      excludes: [],
      includes: [],
      ignoreFiles: []
    }, "semantic");

    assert.equal(semantic.ignoreFiles.filter(file => file === ".semantic-gate.ignore").length, 1);
    assert.equal(semantic.ignoreFiles.includes(".quality-gate.ignore"), false);

    const combined = resolveScopeFiles(temp, {
      scope: "full",
      paths: [],
      excludes: [],
      includes: [],
      ignoreFiles: []
    }, "combined");

    assert.equal(combined.ignoreFiles.filter(file => file === ".semantic-gate.ignore").length, 1);
    assert.equal(combined.ignoreFiles.filter(file => file === ".quality-gate.ignore").length, 1);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stderr}`);
}

test("baseline create can use an existing summary report without running gates", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "code-approval-baseline-"));
  try {
    const reports = path.join(temp, ".quality", "reports", "full");
    fs.mkdirSync(reports, { recursive: true });
    const qualityReport = path.join(reports, "quality-report.json");
    fs.writeFileSync(qualityReport, JSON.stringify({
      findings: [
        { tool: "unit", rule: "demo", path: "src/app.js", line: 1, message: "demo finding" }
      ]
    }), "utf8");
    const summary = path.join(reports, "summary.json");
    fs.writeFileSync(summary, JSON.stringify({
      reports: { qualityJson: qualityReport }
    }), "utf8");

    const baselinePath = path.join(temp, ".quality", "baseline", "baseline.json");
    const result = spawnSync(process.execPath, [
      CLI,
      "baseline",
      "create",
      "--from-report",
      summary,
      "--output",
      baselinePath,
      "--json",
      "--no-interactive"
    ], { cwd: temp, encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    assert.equal(baseline.findings.length, 1);
    assert.equal(baseline.findings[0].gate, "quality");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("baseline create uses configured baseline path when output is omitted", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "code-approval-baseline-config-"));
  try {
    fs.writeFileSync(path.join(temp, ".code-approval-gates.json"), JSON.stringify({
      defaultScope: "paths",
      paths: ["docs"],
      baseline: { path: ".quality/baseline/custom-baseline.json" }
    }), "utf8");
    const reports = path.join(temp, ".quality", "reports", "full");
    fs.mkdirSync(reports, { recursive: true });
    const summary = path.join(reports, "summary.json");
    fs.writeFileSync(summary, JSON.stringify({ reports: {} }), "utf8");

    const result = spawnSync(process.execPath, [
      CLI,
      "baseline",
      "create",
      "--from-report",
      summary,
      "--json",
      "--no-interactive"
    ], { cwd: temp, encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const baselinePath = path.join(temp, ".quality", "baseline", "custom-baseline.json");
    assert.ok(fs.existsSync(baselinePath));
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    assert.equal(baseline.scope, "full");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("run fails clearly when both gates are disabled", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "code-approval-no-gates-"));
  try {
    const result = spawnSync(process.execPath, [
      CLI,
      "run",
      "--no-quality",
      "--no-semantic",
      "--json",
      "--no-interactive"
    ], { cwd: temp, encoding: "utf8" });

    assert.equal(result.status, 2);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.code, "NO_GATES_ENABLED");
    assert.equal(payload.error.code, "NO_GATES_ENABLED");
    assert.equal(payload.exitCode, 2);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("help command prints command-specific help", () => {
  const result = spawnSync(process.execPath, [
    CLI,
    "help",
    "run"
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /code-approval-gates run/);
  assert.match(result.stdout, /Runs Quality Gate and Semantic Gate together/);
});

test("run does not activate configured baseline unless --baseline is passed", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "code-approval-run-baseline-config-"));
  try {
    fs.writeFileSync(path.join(temp, ".code-approval-gates.json"), JSON.stringify({
      baseline: { path: ".quality/baseline/baseline.json" }
    }), "utf8");
    run("git", ["init"], temp);
    run("git", ["add", ".code-approval-gates.json"], temp);
    run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], temp);

    const result = spawnSync(process.execPath, [
      CLI,
      "run",
      "--scope",
      "changed",
      "--no-semantic",
      "--json",
      "--no-interactive"
    ], { cwd: temp, encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(fs.readFileSync(path.join(temp, ".quality", "reports", "latest", "summary.json"), "utf8"));
    assert.equal(summary.baselineUsed, false);
    assert.equal(summary.scoreAppliesTo, "changed-files");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("doctor with mock provider reports provider config as OK", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "code-approval-doctor-mock-"));
  try {
    fs.writeFileSync(
      path.join(temp, ".code-approval-gates.json"),
      JSON.stringify({
        semantic: {
          provider: "mock",
          model: "mock",
        },
      }),
      "utf8",
    );

    const result = spawnSync(process.execPath, [
      CLI,
      "doctor",
      "semantic",
      "--cwd",
      temp,
      "--json",
      "--no-interactive",
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status === "OK" || payload.status === "WARNING", true);
    const providerCheck = payload.checks.find((check) => check.name === "semantic-provider-config");
    assert.equal(providerCheck?.message.includes("Mock provider selected"), true);
    assert.equal(providerCheck?.status, "OK");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("run changed scope with no matching files returns approved summary with empty-scope scores", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "code-approval-run-empty-"));
  try {
    run("git", ["init"], temp);

    const result = spawnSync(process.execPath, [
      CLI,
      "run",
      "--scope",
      "changed",
      "--no-interactive",
      "--json",
      "--output",
      ".quality/reports/empty-scan"
    ], { cwd: temp, encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, "APPROVED");
    assert.equal(summary.scope, "changed");
    assert.equal(summary.scoreAppliesTo, "changed-files");
    assert.equal(summary.finalScore, 100);
    assert.equal(summary.qualityScore, 100);
    assert.equal(summary.semanticScore, 100);
    assert.equal(summary.scopeResolution.fileCount, 0);
    assert.equal(summary.scopeResolution.ignoredCount >= 0, true);
    assert.equal(summary.message, "No files matched the requested scope after ignore rules.");
    assert.equal(Array.isArray(summary.gates), true);
    assert.equal(summary.gates.length, 2);
    assert.deepEqual(summary.gates.map((gate) => gate.name), ["semantic", "quality"]);
    assert.deepEqual(summary.gates.map((gate) => gate.score), [100, 100]);
    assert.deepEqual(summary.gates.map((gate) => gate.skipped), [true, true]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("config set writes dot-path values and config get reads them", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "code-approval-config-"));
  try {
    const setResult = spawnSync(process.execPath, [
      CLI,
      "config",
      "set",
      "baseline.path",
      ".quality/baseline/custom.json",
      "--json",
      "--no-interactive"
    ], { cwd: temp, encoding: "utf8" });

    assert.equal(setResult.status, 0, setResult.stderr);

    const getResult = spawnSync(process.execPath, [
      CLI,
      "config",
      "get",
      "baseline.path",
      "--json",
      "--no-interactive"
    ], { cwd: temp, encoding: "utf8" });

    assert.equal(getResult.status, 0, getResult.stderr);
    assert.equal(JSON.parse(getResult.stdout), ".quality/baseline/custom.json");

    const setProvider = spawnSync(process.execPath, [
      CLI,
      "config",
      "set",
      "semantic.provider",
      "codex-cli",
      "--json",
      "--no-interactive"
    ], { cwd: temp, encoding: "utf8" });

    assert.equal(setProvider.status, 0, setProvider.stderr);

    const setModel = spawnSync(process.execPath, [
      CLI,
      "config",
      "set",
      "semantic.model",
      "gpt-5.5",
      "--json",
      "--no-interactive"
    ], { cwd: temp, encoding: "utf8" });

    assert.equal(setModel.status, 0, setModel.stderr);

    const getSemantic = spawnSync(process.execPath, [
      CLI,
      "config",
      "get",
      "semantic",
      "--json",
      "--no-interactive"
    ], { cwd: temp, encoding: "utf8" });

    assert.equal(getSemantic.status, 0, getSemantic.stderr);
    assert.deepEqual(JSON.parse(getSemantic.stdout), {
      provider: "codex-cli",
      model: "gpt-5.5"
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("init creates default config and ignore files", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "code-approval-init-"));
  try {
    const result = spawnSync(process.execPath, [
      CLI,
      "init",
      "--json",
      "--no-interactive"
    ], { cwd: temp, encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(temp, ".code-approval-gates.json")));
    const config = JSON.parse(fs.readFileSync(path.join(temp, ".code-approval-gates.json"), "utf8"));
    const exampleConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", ".code-approval-gates.example.json"), "utf8"));
    assert.deepEqual(config, exampleConfig);
    assert.equal(config.output, ".quality/reports/latest");
    assert.equal(config.baseline.path, ".quality/baseline/baseline.json");
    assert.ok(fs.existsSync(path.join(temp, ".code-approval-gates.ignore")));
    assert.ok(fs.existsSync(path.join(temp, ".quality-gate.ignore")));
    assert.ok(fs.existsSync(path.join(temp, ".semantic-gate.ignore")));
    assert.match(fs.readFileSync(path.join(temp, ".quality-gate.ignore"), "utf8"), /playwright-report\//);
    assert.match(fs.readFileSync(path.join(temp, ".quality-gate.ignore"), "utf8"), /projects\/\*\*\/artifacts\//);
    assert.match(fs.readFileSync(path.join(temp, ".semantic-gate.ignore"), "utf8"), /package-lock\.json/);
    assert.match(fs.readFileSync(path.join(temp, ".semantic-gate.ignore"), "utf8"), /\*\.min\.js/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
