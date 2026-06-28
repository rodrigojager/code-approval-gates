"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  DEFAULT_IMAGE,
  parseArgs,
  buildDockerArgs,
  commandLine,
  isDockerAvailable,
  canBuildBundledImage
} = require("../bin/quality-check.js");

test("parseArgs keeps quality gate flags for the container", () => {
  const parsed = parseArgs([
    ".",
    "--threshold",
    "90",
    "--profile",
    "strict",
    "--allow-path",
    "samples/**",
    "--enable-secrets"
  ], {});

  assert.equal(parsed.target, ".");
  assert.equal(parsed.image, DEFAULT_IMAGE);
  assert.deepEqual(parsed.containerArgs, [
    "--threshold",
    "90",
    "--profile",
    "strict",
    "--allow-path",
    "samples/**",
    "--enable-secrets"
  ]);
});

test("parseArgs consumes wrapper-only flags", () => {
  const parsed = parseArgs([
    "src",
    "--image",
    "harness-gates/quality-sidecar:dev",
    "--pull",
    "--docker-arg",
    "--network=none",
    "--debug-docker",
    "--format",
    "json"
  ], {});

  assert.equal(parsed.target, "src");
  assert.equal(parsed.image, "harness-gates/quality-sidecar:dev");
  assert.equal(parsed.pull, true);
  assert.equal(parsed.build, true);
  assert.equal(parsed.debugDocker, true);
  assert.deepEqual(parsed.dockerArgs, ["--network=none"]);
  assert.deepEqual(parsed.containerArgs, ["--format", "json"]);
});

test("parseArgs normalizes PowerShell comma-expanded format values", () => {
  const parsed = parseArgs([".", "--format", "json md", "--threshold", "90"], {});
  assert.deepEqual(parsed.containerArgs, ["--format", "json,md", "--threshold", "90"]);

  const equalsParsed = parseArgs([".", "--format=json md"], {});
  assert.deepEqual(equalsParsed.containerArgs, ["--format=json,md"]);
});

test("parseArgs supports explicit build controls", () => {
  assert.equal(parseArgs(["--no-build"], {}).build, false);
  assert.equal(parseArgs(["--build"], { QUALITY_CHECK_NO_BUILD: "1" }).build, true);
  assert.equal(parseArgs([], { QUALITY_CHECK_AUTO_BUILD: "0" }).build, false);
});

test("parseArgs rejects missing wrapper values except docker-arg dash values", () => {
  assert.throws(() => parseArgs(["--image", "--pull"], {}), /Missing value/);
  const parsed = parseArgs(["--docker-arg", "--network=none"], {});
  assert.deepEqual(parsed.dockerArgs, ["--network=none"]);
});

test("buildDockerArgs creates the expected sidecar invocation", () => {
  const targetPath = path.resolve("sample-project");
  const parsed = parseArgs(["sample-project", "--threshold", "90"], {});
  const dockerArgs = buildDockerArgs(parsed, targetPath);

  assert.deepEqual(dockerArgs.slice(0, 2), ["run", "--rm"]);
  assert.ok(dockerArgs.includes(`${targetPath}:/workspace`));
  assert.ok(dockerArgs.includes(`${path.join(targetPath, ".quality", "reports")}:/workspace/.quality/reports`));
  assert.deepEqual(dockerArgs.slice(-4), ["check", "/workspace", "--threshold", "90"]);
});

test("commandLine quotes paths with spaces for debug output", () => {
  const line = commandLine("docker", ["run", "-v", "C:\\Project Files:/workspace"]);
  assert.match(line, /^docker run -v "/);
  assert.match(line, /Project Files/);
});

test("isDockerAvailable validates server output", () => {
  assert.equal(
    isDockerAvailable({}, () => ({ status: 0, stdout: "28.1.1\n", stderr: "" })),
    true
  );
  assert.equal(
    isDockerAvailable({}, () => ({ status: 0, stdout: "", stderr: "Internal Server Error" })),
    false
  );
});

test("runDockerWrapper propagates docker run exit code", () => {
  const {
    runDockerWrapper
  } = require("../bin/quality-check.js");
  const fs = require("node:fs");
  const os = require("node:os");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "quality-check-wrapper-"));
  const target = path.join(temp, "target");
  fs.mkdirSync(target);
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, args]);
    if (args[0] === "version") {
      return { status: 0, stdout: "28.1.1\n", stderr: "" };
    }
    if (args[0] === "image") {
      return { status: 0 };
    }
    if (args[0] === "run") {
      return { status: 7 };
    }
    return { status: 3 };
  };

  const exitCode = runDockerWrapper([target, "--image", "example/sidecar:test", "--threshold", "90"], process.env, runner);
  assert.equal(exitCode, 7);
  const runCall = calls.find(([, args]) => args[0] === "run");
  assert.ok(runCall);
  const dockerArgs = runCall[1];
  assert.deepEqual(dockerArgs.slice(0, 2), ["run", "--rm"]);
  assert.ok(dockerArgs.includes("example/sidecar:test"));
  assert.deepEqual(dockerArgs.slice(-4), ["check", "/workspace", "--threshold", "90"]);
  assert.ok(fs.existsSync(path.join(target, ".quality", "reports")));
});

test("runDockerWrapper builds bundled image when default image is missing", () => {
  const {
    runDockerWrapper
  } = require("../bin/quality-check.js");
  const fs = require("node:fs");
  const os = require("node:os");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "quality-check-wrapper-"));
  const target = path.join(temp, "target");
  fs.mkdirSync(target);
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, args]);
    if (args[0] === "version") {
      return { status: 0, stdout: "28.1.1\n", stderr: "" };
    }
    if (args[0] === "image") {
      return { status: 1 };
    }
    if (args[0] === "build") {
      return { status: 0 };
    }
    if (args[0] === "run") {
      return { status: 0 };
    }
    return { status: 3 };
  };

  const exitCode = runDockerWrapper([target, "--image", "example/sidecar:test"], process.env, runner);
  assert.equal(exitCode, 0);
  assert.ok(calls.some(([, args]) => args[0] === "build" && args.includes("example/sidecar:test")));
  assert.ok(calls.some(([, args]) => args[0] === "run"));
});

test("canBuildBundledImage validates packaged build context", () => {
  assert.equal(canBuildBundledImage(path.resolve(__dirname, "..")), true);
});
