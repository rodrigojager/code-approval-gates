"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  parseArgs,
  normalizedOptions,
  buildEquivalentCommand
} = require("../bin/code-approval-gates.js");

const CLI = path.resolve(__dirname, "..", "bin", "code-approval-gates.js");

test("unified CLI parses language-agnostic evidence flags", () => {
  const parsed = parseArgs([
    "quality",
    "--max-file-lines", "900",
    "--disable-budgets",
    "--dependency-graph", "deps.json",
    "--evidence-report", "quality.json",
    "--test-report", "junit.xml",
    "--allow-dependency-cycles",
    "--locale", "pt-BR",
    "--require-policy",
    "--policy-sha256", "a".repeat(64),
    "--require-evidence-provenance",
    "--expected-source-commit", "deadbeef",
    "--max-evidence-age-seconds", "3600"
  ]);

  assert.equal(parsed.options.maxFileLines, 900);
  assert.equal(parsed.options.disableBudgets, true);
  assert.deepEqual(parsed.options.dependencyGraphs, ["deps.json"]);
  assert.deepEqual(parsed.options.evidenceReports, ["quality.json"]);
  assert.deepEqual(parsed.options.testReports, ["junit.xml"]);
  assert.equal(parsed.options.allowDependencyCycles, true);
  assert.equal(parsed.options.locale, "pt-BR");
  assert.equal(parsed.options.requirePolicy, true);
  assert.equal(parsed.options.policySha256, "a".repeat(64));
  assert.equal(parsed.options.requireEvidenceProvenance, true);
  assert.equal(parsed.options.expectedSourceCommit, "deadbeef");
  assert.equal(parsed.options.maxEvidenceAgeSeconds, 3600);
});

test("quality config is rendered into the reproducible command", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-config-"));
  try {
    fs.writeFileSync(path.join(root, ".code-approval-gates.json"), JSON.stringify({
      defaultScope: "changed",
      quality: {
        enabled: true,
        profile: "strict",
        locale: "pt-BR",
        policyFile: ".quality-gate-policy.json",
        requirePolicy: true,
        policySha256: "a".repeat(64),
        requireEvidenceProvenance: true,
        expectedSourceCommit: "deadbeef",
        maxEvidenceAgeSeconds: 3600,
        budgets: { maxFileLines: 1200, maxChangedFiles: 40 },
        dependencyGraph: { reports: ["deps.json"], maxFanOut: 15 },
        evidenceReports: ["quality-evidence.json"],
        testQuality: { reports: ["junit.xml"], minTests: 10 }
      },
      semantic: { enabled: false }
    }), "utf8");

    const options = normalizedOptions(root, {});
    const command = buildEquivalentCommand("quality", options);

    assert.match(command, /--policy-file \.quality-gate-policy\.json/);
    assert.match(command, /--locale pt-BR/);
    assert.match(command, /--require-policy/);
    assert.match(command, new RegExp(`--policy-sha256 ${"a".repeat(64)}`));
    assert.match(command, /--require-evidence-provenance/);
    assert.match(command, /--expected-source-commit deadbeef/);
    assert.match(command, /--max-evidence-age-seconds 3600/);
    assert.match(command, /--max-file-lines 1200/);
    assert.match(command, /--max-changed-files 40/);
    assert.match(command, /--max-dependency-fan-out 15/);
    assert.match(command, /--dependency-graph deps\.json/);
    assert.match(command, /--evidence-report quality-evidence\.json/);
    assert.match(command, /--test-report junit\.xml/);
    assert.match(command, /--min-tests 10/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unified CLI treats a quality rejection as a gate decision, not an operational error", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-decision-"));
  try {
    const init = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    fs.writeFileSync(path.join(root, "large.txt"), "one\ntwo\nthree\n", "utf8");

    const result = spawnSync(process.execPath, [
      CLI,
      "quality",
      "--scope", "changed",
      "--max-file-lines", "2",
      "--mode", "quick",
      "--no-start-docker",
      "--output", ".quality/reports/rejected",
      "--json",
      "--no-interactive"
    ], { cwd: root, encoding: "utf8" });

    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, "NEEDS_CHANGES");
    assert.deepEqual(summary.errors, []);
    assert.equal(summary.gates[0].status, "REJECTED");
    assert.equal(summary.gates[0].exitCode, 1);
    const report = JSON.parse(fs.readFileSync(summary.reports.qualityJson, "utf8"));
    assert.equal(report.metrics.budgets.maxFileLines, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("GitLab merge request range preserves diff budgets and report artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-gitlab-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
    return result.stdout.trim();
  };
  try {
    git("init");
    git("config", "user.name", "GitLab Test");
    git("config", "user.email", "gitlab@example.invalid");
    fs.writeFileSync(path.join(root, "app.txt"), "one\n", "utf8");
    git("add", ".");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    fs.writeFileSync(path.join(root, "app.txt"), "one\ntwo\nthree\n", "utf8");
    git("add", ".");
    git("commit", "-m", "feature");
    const head = git("rev-parse", "HEAD");

    const result = spawnSync(process.execPath, [
      CLI,
      "quality",
      "--scope", "changed",
      "--max-changed-lines", "1",
      "--mode", "quick",
      "--no-start-docker",
      "--output", "code-approval-report",
      "--json",
      "--no-interactive"
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "true",
        GITLAB_CI: "true",
        CI_MERGE_REQUEST_DIFF_BASE_SHA: base,
        CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main",
        CI_COMMIT_SHA: head
      }
    });

    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, "NEEDS_CHANGES");
    assert.equal(summary.scopeResolution.base, base);
    const scope = JSON.parse(fs.readFileSync(path.join(root, "code-approval-report", "quality-scope.json"), "utf8"));
    assert.equal(scope.diff.base, base);
    assert.equal(scope.diff.head, head);
    assert.equal(scope.diff.fileCount, 1);
    assert.ok(scope.diff.changedLines > 1);
    assert.ok(fs.existsSync(path.join(root, "code-approval-report", "quality-report.json")));
    assert.ok(fs.existsSync(path.join(root, "code-approval-report", "summary.json")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("policy-declared neutral evidence works end to end in an ignored directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-policy-e2e-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
  };
  try {
    git("init");
    git("config", "user.name", "Policy Test");
    git("config", "user.email", "policy@example.invalid");
    fs.writeFileSync(path.join(root, "app.txt"), "before\n", "utf8");
    fs.writeFileSync(path.join(root, ".quality-gate-policy.json"), JSON.stringify({
      schemaVersion: 1,
      evidence: {
        reports: [".quality/evidence/quality.json"],
        requiredMetrics: { "mutation.score": { min: 80 } }
      }
    }), "utf8");
    git("add", ".");
    git("commit", "-m", "base");
    fs.writeFileSync(path.join(root, "app.txt"), "before\nafter\n", "utf8");
    fs.mkdirSync(path.join(root, ".quality", "evidence"), { recursive: true });
    fs.writeFileSync(path.join(root, ".quality", "evidence", "quality.json"), JSON.stringify({
      schemaVersion: 1,
      metrics: { "mutation.score": 70 },
      checks: []
    }), "utf8");

    const result = spawnSync(process.execPath, [
      CLI,
      "quality",
      "--scope", "changed",
      "--mode", "quick",
      "--no-start-docker",
      "--output", ".quality/reports/policy-e2e",
      "--json",
      "--no-interactive"
    ], { cwd: root, encoding: "utf8" });

    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, "NEEDS_CHANGES");
    assert.deepEqual(summary.errors, []);
    const report = JSON.parse(fs.readFileSync(summary.reports.qualityJson, "utf8"));
    assert.ok(report.findings.some((finding) => finding.rule === "evidence.metric.mutation.score"));
    const evidence = report.tools.find((tool) => tool.name === "quality-evidence");
    assert.equal(evidence.status, "findings");
    assert.equal(evidence.output_path.endsWith(".quality\\evidence\\quality.json") || evidence.output_path.endsWith(".quality/evidence/quality.json"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("deletion-only changes still run diff budgets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-deletion-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
  };
  try {
    git("init");
    git("config", "user.name", "Deletion Test");
    git("config", "user.email", "deletion@example.invalid");
    fs.writeFileSync(path.join(root, "removed.txt"), "one\ntwo\nthree\n", "utf8");
    git("add", ".");
    git("commit", "-m", "base");
    fs.rmSync(path.join(root, "removed.txt"));

    const result = spawnSync(process.execPath, [
      CLI,
      "quality",
      "--scope", "changed",
      "--max-changed-lines", "1",
      "--mode", "quick",
      "--no-start-docker",
      "--output", ".quality/reports/deletion",
      "--json",
      "--no-interactive"
    ], { cwd: root, encoding: "utf8" });

    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.ok(summary.scopeResolution.files.includes("removed.txt"));
    const report = JSON.parse(fs.readFileSync(summary.reports.qualityJson, "utf8"));
    assert.equal(report.metrics.change.deletions, 3);
    assert.ok(report.findings.some((finding) => finding.rule === "budget.changed-lines"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
