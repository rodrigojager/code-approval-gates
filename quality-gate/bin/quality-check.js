#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_IMAGE = "harness-gates/quality-sidecar:latest";
const PACKAGE_ROOT = path.resolve(__dirname, "..");

function takeValue(raw, index, flag, options = {}) {
  const value = raw[index + 1];
  if (value === undefined || (!options.allowFlagValue && value.startsWith("--"))) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function normalizeFormatValue(value) {
  return String(value).trim().split(/[\s,]+/).filter(Boolean).join(",");
}

function parseArgs(rawArgs, env = process.env) {
  const raw = [...rawArgs];
  const parsed = {
    target: ".",
    image: env.QUALITY_SIDECAR_IMAGE || DEFAULT_IMAGE,
    pull: false,
    noPull: false,
    build: env.QUALITY_CHECK_AUTO_BUILD !== "0" && env.QUALITY_CHECK_NO_BUILD !== "1",
    debugDocker: false,
    dockerArgs: [],
    containerArgs: []
  };

  if (raw[0] && !raw[0].startsWith("-")) {
    parsed.target = raw.shift();
  }

  for (let i = 0; i < raw.length; i += 1) {
    const arg = raw[i];

    if (arg === "--image" || arg === "-Image" || arg === "-image") {
      parsed.image = takeValue(raw, i, arg);
      i += 1;
      continue;
    }

    if (arg.startsWith("--image=")) {
      parsed.image = arg.slice("--image=".length);
      continue;
    }

    if (arg === "--pull" || arg === "-Pull" || arg === "-pull") {
      parsed.pull = true;
      continue;
    }

    if (arg === "--no-pull" || arg === "-NoPull" || arg === "-noPull") {
      parsed.noPull = true;
      continue;
    }

    if (arg === "--build" || arg === "-Build" || arg === "-build") {
      parsed.build = true;
      continue;
    }

    if (arg === "--no-build" || arg === "-NoBuild" || arg === "-noBuild") {
      parsed.build = false;
      continue;
    }

    if (arg === "--debug-docker" || arg === "-DebugDocker" || arg === "-debugDocker") {
      parsed.debugDocker = true;
      continue;
    }

    if (arg === "--docker-arg" || arg === "-DockerArg" || arg === "-dockerArg") {
      parsed.dockerArgs.push(takeValue(raw, i, arg, { allowFlagValue: true }));
      i += 1;
      continue;
    }

    if (arg.startsWith("--docker-arg=")) {
      parsed.dockerArgs.push(arg.slice("--docker-arg=".length));
      continue;
    }

    if (arg === "--format") {
      parsed.containerArgs.push(arg, normalizeFormatValue(takeValue(raw, i, arg)));
      i += 1;
      continue;
    }

    if (arg.startsWith("--format=")) {
      parsed.containerArgs.push(`--format=${normalizeFormatValue(arg.slice("--format=".length))}`);
      continue;
    }

    parsed.containerArgs.push(arg);
  }

  if (parsed.pull && parsed.noPull) {
    parsed.pull = false;
  }

  return parsed;
}

function ensureTarget(target) {
  const targetPath = path.resolve(target);
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Target path does not exist: ${targetPath}`);
  }
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    throw new Error(`Target path must be a directory: ${targetPath}`);
  }
  return targetPath;
}

function buildDockerArgs(parsed, targetPath) {
  const reportsPath = path.join(targetPath, ".quality", "reports");
  return [
    "run",
    "--rm",
    ...parsed.dockerArgs,
    "-v",
    `${targetPath}:/workspace`,
    "-v",
    `${reportsPath}:/workspace/.quality/reports`,
    "-w",
    "/workspace",
    parsed.image,
    "check",
    "/workspace",
    ...parsed.containerArgs
  ];
}

function quoteForDisplay(value) {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function commandLine(command, args) {
  return [command, ...args].map(quoteForDisplay).join(" ");
}

function isDockerAvailable(env = process.env, runner = spawnSync) {
  const result = runner("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    errors: "replace",
    env,
    timeout: 15000
  });
  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();
  return !result.error && result.status === 0 && stdout.length > 0 && !/internal server error/i.test(stderr);
}

function imageExists(image, env = process.env, runner = spawnSync) {
  const result = runner("docker", ["image", "inspect", image], {
    encoding: "utf8",
    errors: "replace",
    env,
    timeout: 15000
  });
  return !result.error && result.status === 0;
}

function canBuildBundledImage(packageRoot = PACKAGE_ROOT) {
  return fs.existsSync(path.join(packageRoot, "Dockerfile")) &&
    fs.existsSync(path.join(packageRoot, "sidecar")) &&
    fs.existsSync(path.join(packageRoot, "docker", "entrypoint.sh"));
}

function buildBundledImage(image, env = process.env, runner = spawnSync, packageRoot = PACKAGE_ROOT) {
  if (!canBuildBundledImage(packageRoot)) {
    console.error(
      `Docker image ${image} was not found locally and this installation does not include the bundled sidecar build context. ` +
      "Run with --pull, pass --image <existing-image>, or install from the full repository/package."
    );
    return 3;
  }

  console.error(`Docker image ${image} was not found locally. Building the bundled quality-sidecar image...`);
  const result = runner("docker", ["build", "-t", image, packageRoot], {
    stdio: "inherit",
    env
  });
  if (result.error) {
    console.error(`Failed to execute docker build: ${result.error.message}`);
    return 3;
  }
  return result.status ?? 3;
}

function runDockerWrapper(rawArgs, env = process.env, runner = spawnSync) {
  let parsed;
  let targetPath;

  try {
    parsed = parseArgs(rawArgs, env);
    targetPath = ensureTarget(parsed.target);
  } catch (error) {
    console.error(error.message);
    return 3;
  }

  const reportsPath = path.join(targetPath, ".quality", "reports");
  fs.mkdirSync(reportsPath, { recursive: true });

  if (!isDockerAvailable(env, runner)) {
    console.error(
      "Docker nao esta instalado, iniciado ou acessivel. O comando quality-check precisa do Docker para executar a analise completa."
    );
    return 3;
  }

  if (parsed.pull) {
    const pullResult = runner("docker", ["pull", parsed.image], { stdio: "inherit", env });
    if (pullResult.error) {
      console.error(`Falha ao executar docker pull: ${pullResult.error.message}`);
      return 3;
    }
    if (pullResult.status !== 0) {
      return pullResult.status ?? 3;
    }
  }

  if (parsed.build && !imageExists(parsed.image, env, runner)) {
    const buildExitCode = buildBundledImage(parsed.image, env, runner);
    if (buildExitCode !== 0) {
      return buildExitCode;
    }
  }

  const dockerArgs = buildDockerArgs(parsed, targetPath);
  if (parsed.debugDocker) {
    console.log(commandLine("docker", dockerArgs));
  }

  const result = runner("docker", dockerArgs, { stdio: "inherit", env });
  if (result.error) {
    console.error(`Falha ao executar docker run: ${result.error.message}`);
    return 3;
  }

  return result.status ?? 3;
}

if (require.main === module) {
  process.exit(runDockerWrapper(process.argv.slice(2)));
}

module.exports = {
  DEFAULT_IMAGE,
  PACKAGE_ROOT,
  parseArgs,
  ensureTarget,
  buildDockerArgs,
  quoteForDisplay,
  commandLine,
  isDockerAvailable,
  imageExists,
  canBuildBundledImage,
  buildBundledImage,
  normalizeFormatValue,
  runDockerWrapper
};
