import path from "node:path";
import { collectGitReviewContext } from "./context.js";
import { SemanticGateError } from "./errors.js";
import { callProvider } from "./providers.js";
import { buildPromptChunks, buildSynthesisPrompt, systemPrompt } from "./prompt.js";
import { writeReports } from "./report.js";
import { mergeLocalFallbackResult, normalizeGateResult, parseProviderResult } from "./result.js";
import type { GateResult, ObjectiveInput, ProviderResponse, SemanticGateConfig } from "./types.js";

export interface RunSemanticGateOptions {
  cwd: string;
  config: SemanticGateConfig;
  objective: ObjectiveInput;
}

export async function runSemanticGate(options: RunSemanticGateOptions): Promise<{
  result: GateResult;
  reports?: { jsonPath: string; markdownPath: string; rawPath: string };
}> {
  const gitContext = await collectGitReviewContext(options.cwd, options.config);
  if (gitContext.changedFiles.length === 0) {
    throw new SemanticGateError("No changed files found to review.", "context");
  }

  const chunks = buildPromptChunks(options.objective, gitContext, options.config);
  const providerResponses: ProviderResponse[] = [];
  const partialResults: GateResult[] = [];
  const provider = options.config.provider ?? "unconfigured";

  for (const chunk of chunks) {
    const response = await callProvider({
      prompt: chunk.prompt,
      system: systemPrompt(),
      config: options.config,
      cwd: options.cwd,
      chunkLabel: chunk.label,
    });
    providerResponses.push(response);
    partialResults.push(
      normalizeGateResult(parseProviderResult(response.text), optionalModelContext({
        config: options.config,
        objective: options.objective,
        gitContext,
        provider,
      }, options.config.model)),
    );
  }

  let result: GateResult;
  if (partialResults.length === 1) {
    result = partialResults[0]!;
  } else {
    try {
      const synthesis = await callProvider({
        prompt: buildSynthesisPrompt(options.objective, gitContext, partialResults, options.config),
        system: systemPrompt(),
        config: options.config,
        cwd: options.cwd,
        chunkLabel: "final-synthesis",
      });
      providerResponses.push(synthesis);
      result = normalizeGateResult(parseProviderResult(synthesis.text), optionalModelContext({
        config: options.config,
        objective: options.objective,
        gitContext,
        provider,
      }, options.config.model));
    } catch {
      result = mergeLocalFallbackResult(partialResults, optionalModelContext({
        config: options.config,
        objective: options.objective,
        gitContext,
        provider,
      }, options.config.model));
    }
  }

  const outputDir = path.resolve(gitContext.repoRoot, options.config.outputDir);
  if (options.config.writeReports) {
    return { result, reports: writeReports(result, providerResponses, outputDir) };
  }
  return { result };
}

function optionalModelContext<T extends { model?: string }>(context: Omit<T, "model">, model: string | undefined): T {
  return (model === undefined ? context : { ...context, model }) as T;
}
