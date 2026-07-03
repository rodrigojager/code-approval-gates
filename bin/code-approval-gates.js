#!/usr/bin/env node
"use strict";
const fs=require("node:fs");
const path=require("node:path");
const process=require("node:process");
const readline=require("node:readline");
const crypto=require("node:crypto");
const {spawn,spawnSync}=require("node:child_process");
const VERSION="0.1.0";
const ROOT=path.resolve(__dirname,"..");
const QUALITY_BIN=path.join(ROOT,"quality-gate","bin","quality-check.js");
const QUALITY_SIDECAR_DIR=path.join(ROOT,"quality-gate","sidecar");
const SEMANTIC_BIN=path.join(ROOT,"semantic-gate","dist","cli.js");
const DEFAULT_THRESHOLD=90;
const DEFAULT_SEMANTIC_TIMEOUT_MS=300000;
const DEFAULT_OUTPUT=".quality/reports/latest";
const DEFAULT_BASELINE_OUTPUT=".quality/baseline/baseline.json";
const DEFAULT_BASELINE_REPORT_OUTPUT=".quality/reports/baseline-source";
const DEFAULT_OBJECTIVE="Avaliar se o escopo analisado esta pronto para revisao, considerando qualidade, seguranca, arquitetura, testabilidade, documentacao e riscos de manutencao.";
const DEFAULT_CONFIG=".code-approval-gates.json";
const COMMON_IGNORE=".code-approval-gates.ignore";
const QUALITY_IGNORE=".quality-gate.ignore";
const SEMANTIC_IGNORE=".semantic-gate.ignore";
const DEFAULT_IGNORES=[".git/",".quality/","node_modules/","dist/","build/","coverage/",".turbo/",".vite/","__pycache__/","*.pyc","*.pyo","*.log","*.sqlite","*.sqlite3","*.db"];
const SUPPORT_FILES=["package.json","package-lock.json","pnpm-lock.yaml","yarn.lock","bun.lockb","tsconfig.json","jsconfig.json","pyproject.toml","requirements.txt","poetry.lock","Dockerfile","docker-compose.yml","docker-compose.yaml",".gitignore",".eslintrc",".eslintrc.json",".prettierrc",".markdownlint.json",".stylelintrc","README.md"];
const BOOL_FLAGS=new Set(["ci","json","interactive","no-interactive","objective-stdin","fix","fix-network","yes","install-global","non-blocking","no-quality","no-semantic","quality","semantic","pull","no-pull","build","no-build","debug-docker","enable-coverage","enable-secrets","enable-pii","disable-iac","no-iac","allow-pii","allow-secrets","include-untracked","write-reports","no-write-reports","refresh","version","help","progress","no-progress","start-docker","no-start-docker","codex-bypass-sandbox","no-codex-bypass-sandbox","codex-skip-git-repo-check","no-codex-skip-git-repo-check"]);
const MULTI_FLAGS=new Set(["path","exclude","include","ignore-file","docker-arg","allow-rule","allow-path","waiver","coverage-report"]);
const KEY_MAP={"no-interactive":"noInteractive","objective-file":"objectiveFile","objective-stdin":"objectiveStdin","non-blocking":"nonBlocking","fix-network":"fixNetwork","no-quality":"quality","no-semantic":"semantic","ignore-file":"ignoreFiles","base-url":"baseUrl","api-key-env":"apiKeyEnv","api-key-provider":"apiKeyProvider","reasoning-effort":"reasoningEffort","codex-sandbox":"codexSandbox","codex-bypass-sandbox":"codexBypassSandbox","no-codex-bypass-sandbox":"codexBypassSandbox","codex-skip-git-repo-check":"codexSkipGitRepoCheck","no-codex-skip-git-repo-check":"codexSkipGitRepoCheck","output-dir":"outputDir","report-dir":"reportDir","max-context-chars":"maxContextChars","max-file-chars":"maxFileChars","max-diff-chars":"maxDiffChars","context-strategy":"contextStrategy","timeout-ms":"timeoutMs","command-args":"commandArgs","model-list-command":"modelListCommand","model-list-args":"modelListArgs","command-prompt-mode":"commandPromptMode","command-output":"commandOutput","fail-on-tool-error":"failOnToolError","min-line-coverage":"minLineCoverage","min-branch-coverage":"minBranchCoverage","docker-start-timeout-ms":"dockerStartTimeoutMs","docker-arg":"dockerArgs","allow-rule":"allowRules","allow-path":"allowPaths","coverage-report":"coverageReports"};
async function main(argv=process.argv.slice(2)){const parsed=parseArgs(argv);const cwd=path.resolve(String(parsed.options.cwd||process.cwd()));const mode=detectExecutionMode(parsed.options);if(parsed.options.version||parsed.command==="version"){writeHumanOrJson(parsed.options,{version:VERSION},`code-approval-gates ${VERSION}\n`);return 0}if(parsed.options.help||parsed.command==="help"){const helpCommand=resolveHelpCommand(parsed);const helpText=helpFor(helpCommand);writeHumanOrJson(parsed.options,helpPayloadFor(helpCommand,helpText),helpText);return 0}if(!parsed.command){if(mode.interactive)return runWizard(cwd,parsed.options);if(parsed.options.json)return fail(parsed.options,2,"MISSING_COMMAND","No command provided in headless mode.","Use code-approval-gates run --scope changed --json --no-interactive, or code-approval-gates --help.");process.stdout.write(helpFor("root"));return 0}switch(parsed.command){case"wizard":if(mode.interactive)return runWizard(cwd,{...parsed.options,interactive:true});return fail(parsed.options,2,"INTERACTIVE_UNAVAILABLE","Interactive wizard cannot run in headless mode.","Use command flags with --no-interactive, or run in a TTY without --ci/--json.");case"init":return handleInit(cwd,parsed.options);case"doctor":return handleDoctor(cwd,parsed);case"run":if(parsed.options.interactive&&mode.interactive)return runWizard(cwd,parsed.options);return handleRun(cwd,parsed.options,"both");case"quality":return handleRun(cwd,{...parsed.options,semantic:false,quality:true},"quality");case"semantic":return handleRun(cwd,{...parsed.options,semantic:true,quality:false},"semantic");case"baseline":return handleBaseline(cwd,parsed);case"report":return handleReport(cwd,parsed);case"config":return handleConfig(cwd,parsed);default:return fail(parsed.options,2,"UNKNOWN_COMMAND",`Unknown command: ${parsed.command}`,"Use code-approval-gates --help.")}}
function parseArgs(argv){
  const tokens=[...argv];
  const options={paths:[],excludes:[],includes:[],ignoreFiles:[],passthrough:[]};
  let command;
  const positional=[];
  for(let index=0;index<tokens.length;index++){
    const token=tokens[index];
    if(token==="--"){
      options.passthrough.push(...tokens.slice(index+1));
      break;
    }
    if(!token.startsWith("-")){
      if(!command){
        command=token;
        continue;
      }
      positional.push(token);
      continue;
    }
    if(token==="-h"||token==="--help"){
      options.help=true;
      continue;
    }
    if(token==="-v"||token==="--version"){
      options.version=true;
      continue;
    }
    const withoutPrefix=token.replace(/^--?/,"");
    const eq=withoutPrefix.indexOf("=");
    const rawFlag=eq>=0?withoutPrefix.slice(0,eq):withoutPrefix;
    const explicitValue=eq>=0?withoutPrefix.slice(eq+1):undefined;
    const mapped=KEY_MAP[rawFlag]||toCamel(rawFlag);
    if(MULTI_FLAGS.has(rawFlag)){
      const value=explicitValue!==undefined?explicitValue:tokens[++index];
      if(value===undefined)throwUsage(`Missing value for --${rawFlag}`);
      pushOption(options,mapped,value);
      continue;
    }
    if(BOOL_FLAGS.has(rawFlag)){
      const value=explicitValue===undefined?true:parseScalar(explicitValue);
      if(rawFlag==="no-quality"||rawFlag==="no-semantic"||rawFlag==="no-codex-bypass-sandbox"||rawFlag==="no-codex-skip-git-repo-check")options[mapped]=false;
      else options[mapped]=value;
      continue;
    }
    const value=explicitValue!==undefined?explicitValue:tokens[index+1];
    if(value===undefined||(explicitValue===undefined&&value.startsWith("--"))){
      options[mapped]=true;
      options.passthrough.push(token);
      continue;
    }
    if(explicitValue===undefined)index++;
    options[mapped]=parseScalar(value);
  }
  return{command,positional,options};
}
function pushOption(options,mapped,value){if(mapped==="path"){options.paths.push(value);return}if(mapped==="exclude"){options.excludes.push(value);return}if(mapped==="include"){options.includes.push(value);return}if(!Array.isArray(options[mapped]))options[mapped]=[];options[mapped].push(value)}
function parseScalar(value){const text=String(value);if(text==="true")return true;if(text==="false")return false;if(text==="null")return null;if(/^-?\d+(\.\d+)?$/.test(text))return Number(text);return value}
function toCamel(value){return value.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())}
function throwUsage(message){const error=new Error(message);error.code="USAGE";throw error}
function resolveHelpCommand(parsed){if(parsed.command==="help")return parsed.positional.length?parsed.positional.slice(0,2).join(" "):"root";return[parsed.command,...parsed.positional].filter(Boolean).slice(0,2).join(" ")||"root"}
function detectExecutionMode(options){const ci=Boolean(options.ci||process.env.CI||process.env.GITLAB_CI||process.env.GITHUB_ACTIONS);const noInteractive=Boolean(options.noInteractive||options.json||ci);const interactive=Boolean(!noInteractive&&process.stdin.isTTY&&process.stdout.isTTY);return{ci,noInteractive,interactive,headless:!interactive}}
function normalizedOptions(cwd,options){
  const config=loadProjectConfig(cwd);
  const requestedGate=options.gate===undefined?undefined:String(options.gate);
  if(requestedGate!==undefined&&!(["quality","semantic","both"].includes(requestedGate)))throwUsage("--gate must be quality, semantic, or both");
  const scope=String(options.scope||config.defaultScope||"changed");
  if(!["changed","full","paths"].includes(scope))throwUsage("--scope must be changed, full, or paths");
  const threshold=Number(options.threshold||config.threshold||DEFAULT_THRESHOLD);
  const output=String(options.output||config.output||DEFAULT_OUTPUT);
  const format=normalizeFormat(options.format||config.format||"json,md");
  const cliPaths=Array.isArray(options.paths)?options.paths:[];
  if(cliPaths.length&&scope!=="paths")throwUsage("--path can only be used with --scope paths");
  const configPaths=Array.isArray(config.paths)?config.paths:[];
  const effectivePaths=scope==="paths"?(cliPaths.length?cliPaths:configPaths):[];
  const configExcludes=Array.isArray(config.excludes)?config.excludes:[];
  const configIncludes=Array.isArray(config.includes)?config.includes:[];
  const configIgnoreFiles=Array.isArray(config.ignoreFiles)?config.ignoreFiles:[];
  const cliExcludes=Array.isArray(options.excludes)?options.excludes:[];
  const cliIncludes=Array.isArray(options.includes)?options.includes:[];
  const cliIgnoreFiles=Array.isArray(options.ignoreFiles)?options.ignoreFiles:[];
  let quality=options.quality!==undefined?Boolean(options.quality):options.semantic===true?false:config.quality?.enabled!==false;
  let semantic=options.semantic!==undefined?Boolean(options.semantic):options.quality===true?false:config.semantic?.enabled!==false;
  if(requestedGate==="quality"){
    quality=true;
    semantic=false;
  }else if(requestedGate==="semantic"){
    quality=false;
    semantic=true;
  }else if(requestedGate==="both"){
    quality=true;
    semantic=true;
  }
  return{...config,...options,semanticConfig:config.semantic||{},qualityConfig:config.quality||{},scope,threshold,output,format,quality,semantic,paths:effectivePaths,excludes:[...configExcludes,...cliExcludes],includes:[...configIncludes,...cliIncludes],ignoreFiles:[...configIgnoreFiles,...cliIgnoreFiles]};
}function normalizeFormat(value){return String(value).trim().split(/[\s,]+/).filter(Boolean).join(",")||"json,md"}
function loadProjectConfig(cwd){const configPath=path.join(cwd,DEFAULT_CONFIG);if(!fs.existsSync(configPath))return{};try{return JSON.parse(fs.readFileSync(configPath,"utf8"))}catch(error){return{configError:error.message}}}
async function handleRun(cwd,rawOptions,requestedGate){const options=normalizedOptions(cwd,rawOptions);if(!options.quality&&!options.semantic)return fail(options,2,"NO_GATES_ENABLED","No gates are enabled.","Remove either --no-quality or --no-semantic.");const mode=detectExecutionMode(options);const baselinePathOption=typeof rawOptions.baseline==="string"?rawOptions.baseline:typeof options.baseline==="string"?options.baseline:null;const outputDir=path.resolve(cwd,options.output);fs.mkdirSync(outputDir,{recursive:true});const summary={schemaVersion:1,tool:"code-approval-gates",version:VERSION,status:"ERROR",startedAt:new Date().toISOString(),finishedAt:null,scope:options.scope,scoreAppliesTo:scoreAppliesToForScope(options.scope),mode:mode.headless?"headless":"interactive",interactive:mode.interactive,ci:mode.ci,threshold:options.threshold,commandEquivalent:buildEquivalentCommand(requestedGate,options),base:options.base||null,head:options.head||null,paths:options.paths,excludes:options.excludes,includes:options.includes,baselineUsed:Boolean(baselinePathOption),qualityScore:null,semanticScore:null,finalScore:null,reports:{},scopeResolution:null,gates:[],errors:[]};try{const gateKind=options.semantic&&!options.quality?"semantic":options.quality&&!options.semantic?"quality":"combined";const scopeResolution=resolveScopeFiles(cwd,options,gateKind);summary.scopeResolution=scopeResolution;if(scopeResolution.files.length===0){summary.status="APPROVED";summary.finalScore=100;if(options.quality)summary.qualityScore=100;if(options.semantic)summary.semanticScore=100;summary.gates=emptyScopeGates(options);summary.finishedAt=new Date().toISOString();summary.message="No files matched the requested scope after ignore rules.";writeSummary(outputDir,summary,options);return exitWithSummary(summary,options,0)}if(options.semantic){const semantic=await runSemanticGate(cwd,outputDir,options,mode);summary.gates.push(semantic.gate);summary.reports.semanticJson=semantic.semanticJson||null;summary.reports.semanticMarkdown=semantic.semanticMarkdown||null;summary.semanticScore=semantic.score;if(semantic.error)summary.errors.push(semantic.error)}if(options.quality){const quality=await runQualityGate(cwd,outputDir,options,mode);summary.gates.push(quality.gate);summary.reports.qualityJson=quality.qualityJson||null;summary.reports.qualityMarkdown=quality.qualityMarkdown||null;summary.qualityScore=quality.score;if(quality.error)summary.errors.push(quality.error)}const baseline=baselinePathOption?loadBaseline(path.resolve(cwd,String(baselinePathOption))):null;if(baseline)summary.baseline=compareBaseline(baseline,summary);finalizeSummary(summary,options);writeSummary(outputDir,summary,options);return exitWithSummary(summary,options,summary.status==="APPROVED"||options.nonBlocking?0:1)}catch(error){summary.status="ERROR";summary.finishedAt=new Date().toISOString();summary.errors.push(toErrorObject(error));writeSummary(outputDir,summary,options);return exitWithSummary(summary,options,exitCodeForError(error))}}
function createProjection(cwd,options,gateKind){const scopeResolution=resolveScopeFiles(cwd,options,gateKind);const runId=`${Date.now()}-${Math.random().toString(16).slice(2)}`;const projectionRoot=path.join(cwd,".quality","scopes",runId);const workspace=path.join(projectionRoot,"workspace");fs.mkdirSync(workspace,{recursive:true});for(const file of scopeResolution.files){const source=path.join(cwd,file);const target=path.join(workspace,file);if(!fs.existsSync(source)||!fs.statSync(source).isFile())continue;fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target)}spawnSync("git",["init"],{cwd:workspace,encoding:"utf8",timeout:15000});return{projectionRoot,workspace,scopeResolution}}
function resolveScopeFiles(cwd,options,gateKind){
  const scope=options.scope;
  const ignoreRules=buildIgnoreRules(cwd,gateKind,options);
  let files=[];
  const commands=[];
  let base=options.base;
  let head=options.head;
  if(scope==="paths"&&(!options.paths||options.paths.length===0))throwUsage("--scope paths requires at least one --path");
  if(scope==="changed"){
    const range=resolveGitRange(options);
    base=range.base;
    head=range.head;
    if(range.base||range.head){
      const args=["diff","--name-only",`${range.base||"HEAD"}...${range.head||"HEAD"}`];
      const result=runCaptured("git",args,cwd);
      commands.push(recordCommand("git",args,result));
      files=splitLines(result.stdout);
    }else{
      for(const args of [["diff","--name-only"],["diff","--cached","--name-only"],["ls-files","--others","--exclude-standard"]]){
        const result=runCaptured("git",args,cwd);
        commands.push(recordCommand("git",args,result));
        files.push(...splitLines(result.stdout));
      }
    }
  }else if(scope==="full"){
    const args=["ls-files","-co","--exclude-standard"];
    const result=runCaptured("git",args,cwd);
    commands.push(recordCommand("git",args,result));
    files=result.status===0?splitLines(result.stdout):walkFiles(cwd).map(file=>normalizePath(path.relative(cwd,file)));
  }else if(scope==="paths"){
    for(const targetPath of options.paths){
      const normalized=normalizePath(targetPath);
      const args=["ls-files","-co","--exclude-standard","--",normalized];
      const result=runCaptured("git",args,cwd);
      commands.push(recordCommand("git",args,result));
      files.push(...(result.status===0?splitLines(result.stdout):walkFiles(path.join(cwd,normalized)).map(file=>normalizePath(path.relative(cwd,file)))));
    }
  }
  if(scope==="full")files.push(...collectIncludedFiles(cwd,ignoreRules,[""]));
  else if(scope==="paths")files.push(...collectIncludedFiles(cwd,ignoreRules,options.paths));
  if(scope==="full"||(scope==="changed"&&files.length>0)){
    for(const support of SUPPORT_FILES){
      if(fs.existsSync(path.join(cwd,support)))files.push(support);
    }
  }
  const unique=[...new Set(files.map(normalizePath).filter(Boolean))];
  const filtered=unique.filter(file=>fs.existsSync(path.join(cwd,file))&&fs.statSync(path.join(cwd,file)).isFile()).filter(file=>!isIgnored(file,ignoreRules));
  return{scope,base:base||null,head:head||null,files:filtered.sort(),fileCount:filtered.length,ignoredCount:unique.length-filtered.length,ignoreFiles:ignoreRules.files,commands};
}
function collectIncludedFiles(cwd,ignoreRules,roots){
  const includePatterns=[...new Set(ignoreRules.rules.filter(rule=>rule.include).map(rule=>normalizePath(rule.pattern)).filter(Boolean))];
  if(!includePatterns.length)return[];
  const files=[];
  for(const root of roots.length?roots:[""]){
    const absoluteRoot=path.join(cwd,normalizePath(root));
    for(const filePath of walkFiles(absoluteRoot)){
      const relative=normalizePath(path.relative(cwd,filePath));
      if(includePatterns.some(pattern=>matchesPattern(relative,pattern)))files.push(relative);
    }
  }
  return files;
}
function resolveGitRange(options){if(options.base||options.head)return{base:options.base?String(options.base):undefined,head:options.head?String(options.head):"HEAD"};if(process.env.GITLAB_CI&&process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME)return{base:`origin/${process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME}`,head:process.env.CI_COMMIT_SHA||"HEAD"};if(process.env.GITHUB_BASE_REF)return{base:`origin/${process.env.GITHUB_BASE_REF}`,head:process.env.GITHUB_SHA||"HEAD"};return{base:undefined,head:undefined}}
function buildIgnoreRules(cwd,gateKind,options){const files=[];const rules=[];for(const pattern of DEFAULT_IGNORES)rules.push({pattern,source:"defaults",include:false});const gateIgnoreFiles=gateKind==="semantic"?[SEMANTIC_IGNORE]:gateKind==="quality"?[QUALITY_IGNORE]:[QUALITY_IGNORE,SEMANTIC_IGNORE];const candidates=[...new Set([".gitignore",COMMON_IGNORE,...gateIgnoreFiles,...(options.ignoreFiles||[])].filter(Boolean))];for(const fileName of candidates){const filePath=path.resolve(cwd,fileName);if(!fs.existsSync(filePath)||!fs.statSync(filePath).isFile())continue;files.push(path.relative(cwd,filePath)||fileName);for(const rawLine of fs.readFileSync(filePath,"utf8").split(/\r?\n/)){const line=rawLine.trim();if(!line||line.startsWith("#"))continue;const include=line.startsWith("!");rules.push({pattern:include?line.slice(1):line,source:fileName,include})}}for(const pattern of options.excludes||[])rules.push({pattern,source:"--exclude",include:false});for(const pattern of options.includes||[])rules.push({pattern,source:"--include",include:true});return{rules,files}}
function isIgnored(file,ignoreRules){let ignored=false;for(const rule of ignoreRules.rules){if(matchesPattern(file,rule.pattern))ignored=!rule.include}return ignored}
function matchesPattern(file,pattern){const normalizedFile=normalizePath(file);let normalizedPattern=normalizePath(pattern);if(!normalizedPattern)return false;if(normalizedPattern.endsWith("/")){const prefix=normalizedPattern.replace(/\/+$/,"");return normalizedFile===prefix||normalizedFile.startsWith(`${prefix}/`)||normalizedFile.includes(`/${prefix}/`)}if(!normalizedPattern.includes("/")){return normalizedFile.split("/").some(part=>globRegex(normalizedPattern).test(part))}return globRegex(normalizedPattern).test(normalizedFile)}
function globRegex(pattern){let out="^";for(let i=0;i<pattern.length;i++){const char=pattern[i];const next=pattern[i+1];if(char==="*"&&next==="*"){out+=".*";i++}else if(char==="*")out+="[^/]*";else if(char==="?")out+="[^/]";else out+=escapeRegex(char)}return new RegExp(out+"$")}
function escapeRegex(char){return char.replace(/[|\\{}()[\]^$+*?.]/g,"\\$&")}
function normalizePath(value){return String(value||"").replace(/\\/g,"/").replace(/^\.\//,"").replace(/^\/+/,"")}
function walkFiles(root){if(!fs.existsSync(root))return[];const stat=fs.statSync(root);if(stat.isFile())return[root];const files=[];const stack=[root];while(stack.length){const current=stack.pop();for(const entry of fs.readdirSync(current,{withFileTypes:true})){const full=path.join(current,entry.name);if(entry.isDirectory()){if([".git","node_modules",".quality"].includes(entry.name))continue;stack.push(full)}else if(entry.isFile())files.push(full)}}return files}
async function runSemanticGate(workspace,outputDir,options,mode){
  const objective=readObjective(options,workspace);
  const semanticOutputDir=path.join(outputDir,"semantic-native");
  const semanticTimeoutMs=Number(options.timeoutMs||options.semanticConfig?.timeoutMs||DEFAULT_SEMANTIC_TIMEOUT_MS);
  const args=[SEMANTIC_BIN,"run","--objective-stdin","--include-untracked","--scope",options.scope,"--output-dir",semanticOutputDir,"--json"];
  appendScopeOptions(args,options);
  appendSemanticOption(args,"base",options.base);
  appendSemanticOption(args,"head",options.head);
  appendSemanticOption(args,"provider",options.provider||options.semanticConfig?.provider);
  appendSemanticOption(args,"model",options.model||options.semanticConfig?.model);
  appendSemanticOption(args,"reasoning-effort",options.reasoningEffort||options.semanticConfig?.reasoningEffort);
  appendSemanticOption(args,"timeout-ms",semanticTimeoutMs);
  appendSemanticOption(args,"max-context-chars",options.maxContextChars);
  appendSemanticOption(args,"max-file-chars",options.maxFileChars);
  appendSemanticOption(args,"max-diff-chars",options.maxDiffChars);
  appendSemanticOption(args,"context-strategy",options.contextStrategy);
  appendSemanticOption(args,"base-url",options.baseUrl);
  appendSemanticOption(args,"api-key-env",options.apiKeyEnv);
  const codexSandbox=options.codexSandbox??options.semanticConfig?.codexSandbox??"danger-full-access";
  const codexBypassSandbox=options.codexBypassSandbox??options.semanticConfig?.codexBypassSandbox;
  const codexSkipGitRepoCheck=options.codexSkipGitRepoCheck??options.semanticConfig?.codexSkipGitRepoCheck??true;
  appendSemanticOption(args,"codex-sandbox",codexSandbox);
  if(codexBypassSandbox===true)args.push("--codex-bypass-sandbox");
  else if(codexBypassSandbox===false)args.push("--no-codex-bypass-sandbox");
  if(codexSkipGitRepoCheck===true)args.push("--codex-skip-git-repo-check");
  else if(codexSkipGitRepoCheck===false)args.push("--no-codex-skip-git-repo-check");
  const provider=String(options.provider||options.semanticConfig?.provider||"codex-cli");
  const model=String(options.model||options.semanticConfig?.model||"");
  const result=await runGateProcess(process.execPath,args,{cwd:workspace,input:objective,timeout:semanticTimeoutMs+60000,stdio:mode.headless?["pipe","pipe","pipe"]:["pipe","inherit","inherit"]},progressOptions("semantic",`${provider}${model?`/${model}`:""}`,semanticTimeoutMs,options,mode));
  const sourceDir=semanticOutputDir;
  const semanticJson=copyIfExists(path.join(sourceDir,"semantic-result.json"),path.join(outputDir,"semantic-report.json"));
  const semanticMarkdown=copyIfExists(path.join(sourceDir,"semantic-result.md"),path.join(outputDir,"semantic-report.md"));
  copyDirIfExists(path.join(sourceDir,"raw-provider-output.json"),path.join(outputDir,"raw","semantic","raw-provider-output.json"));
  const report=semanticJson&&fs.existsSync(semanticJson)?readJson(semanticJson):null;
  return{gate:{name:"semantic",command:commandForDisplay(process.execPath,args),exitCode:result.status??5,status:report?.status||(result.status===0?"APPROVED":"ERROR"),score:typeof report?.score==="number"?report.score:null,stdout:mode.headless?trimLog(result.stdout):undefined,stderr:mode.headless?trimLog(result.stderr):undefined},score:typeof report?.score==="number"?report.score:null,semanticJson,semanticMarkdown,error:result.status===0?null:{code:"SEMANTIC_GATE_FAILED",message:trimLog(result.stderr||result.stdout||"Semantic gate failed."),exitCode:result.status??5}};
}
function appendSemanticOption(args,key,value){if(value===undefined||value===null||value==="")return;args.push(`--${key}`,String(value))}
function appendScopeOptions(args,options){if(String(options.scope||"full")==="paths")for(const item of options.paths||[])args.push("--path",item);for(const item of options.excludes||[])args.push("--exclude",item);for(const item of options.includes||[])args.push("--include",item);for(const item of options.ignoreFiles||[])args.push("--ignore-file",item)}
async function runQualityGate(workspace,outputDir,options,mode){
  const qualityOutputDir=path.join(outputDir,"quality-native");
  const args=[QUALITY_BIN,workspace,"--scope",options.scope,"--threshold",String(options.threshold),"--format",options.format,"--output",qualityOutputDir];
  appendScopeOptions(args,options);
  appendQualityOption(args,"profile",options.profile);
  appendQualityOption(args,"mode",options.qualityMode||options.mode);
  appendQualityOption(args,"image",options.image);
  appendQualityOption(args,"min-line-coverage",options.minLineCoverage);
  appendQualityOption(args,"min-branch-coverage",options.minBranchCoverage);
  appendQualityBoolean(args,"pull",options.pull);
  appendQualityBoolean(args,"no-pull",options.noPull);
  appendQualityBoolean(args,"build",options.build);
  appendQualityBoolean(args,"no-build",options.noBuild);
  appendQualityBoolean(args,"start-docker",options.startDocker);
  appendQualityBoolean(args,"no-start-docker",options.noStartDocker);
  appendQualityOption(args,"docker-start-timeout-ms",options.dockerStartTimeoutMs);
  appendQualityBoolean(args,"debug-docker",options.debugDocker);
  appendQualityBoolean(args,"enable-coverage",options.enableCoverage);
  appendQualityBoolean(args,"enable-secrets",options.enableSecrets);
  appendQualityBoolean(args,"enable-pii",options.enablePii);
  appendQualityBoolean(args,"disable-iac",options.disableIac||options.noIac);
  appendQualityBoolean(args,"allow-pii",options.allowPii);
  appendQualityBoolean(args,"allow-secrets",options.allowSecrets);
  for(const item of options.coverageReports||[])args.push("--coverage-report",item);
  for(const item of options.allowRules||[])args.push("--allow-rule",item);
  for(const item of options.allowPaths||[])args.push("--allow-path",item);
  for(const item of options.waiver||[])args.push("--waiver",item);
  for(const item of options.dockerArgs||[])args.push("--docker-arg",item);
  const result=await runGateProcess(process.execPath,args,{cwd:workspace,timeout:Number(options.qualityTimeoutMs||0)||undefined,stdio:mode.headless?["pipe","pipe","pipe"]:"inherit"},progressOptions("quality","deterministic checks",Number(options.qualityTimeoutMs||0)||null,options,mode));
  const qualityJson=copyIfExists(path.join(qualityOutputDir,"quality-report.json"),path.join(outputDir,"quality-report.json"));
  const qualityMarkdown=copyIfExists(path.join(qualityOutputDir,"quality-report.md"),path.join(outputDir,"quality-report.md"));
  copyIfExists(path.join(qualityOutputDir,"quality-scope.json"),path.join(outputDir,"quality-scope.json"));
  copyDirIfExists(path.join(qualityOutputDir,"raw"),path.join(outputDir,"raw","quality"));
  const report=qualityJson&&fs.existsSync(qualityJson)?readJson(qualityJson):null;
  const score=typeof report?.score?.value==="number"?report.score.value:null;
  return{gate:{name:"quality",command:commandForDisplay(process.execPath,args),exitCode:result.status??4,status:report?.status||(result.status===0?"APPROVED":"ERROR"),score,stdout:mode.headless?trimLog(result.stdout):undefined,stderr:mode.headless?trimLog(result.stderr):undefined},score,qualityJson,qualityMarkdown,error:result.status===0?null:{code:"QUALITY_GATE_FAILED",message:trimLog(result.stderr||result.stdout||"Quality gate failed."),exitCode:result.status??4}}
}
function progressOptions(gate,detail,timeoutMs,options,mode){const forced=options.progress===true||process.env.CODE_APPROVAL_GATES_PROGRESS==="1";const disabled=options.noProgress===true||process.env.CODE_APPROVAL_GATES_PROGRESS==="0";return{enabled:mode.headless&&!disabled&&(forced||process.stderr.isTTY),gate,detail,timeoutMs,intervalMs:Number(options.progressIntervalMs||10000)}}
function runGateProcess(command,args,options,progress){
  return new Promise(resolve=>{
    const child=spawn(command,args,{cwd:options.cwd,windowsHide:true,stdio:options.stdio});
    let stdout="";
    let stderr="";
    let settled=false;
    let timedOut=false;
    const started=Date.now();
    const intervalMs=Math.max(1000,Number(progress?.intervalMs||10000));
    const timeoutText=progress?.timeoutMs?` timeout=${Math.ceil(progress.timeoutMs/1000)}s`:"";
    const progressTimer=progress?.enabled?setInterval(()=>{const elapsed=Math.max(1,Math.round((Date.now()-started)/1000));process.stderr.write(`[code-approval-gates] ${progress.gate} gate still running after ${elapsed}s (${progress.detail};${timeoutText||" no child timeout"}).\n`)},intervalMs):undefined;
    if(progress?.enabled)process.stderr.write(`[code-approval-gates] ${progress.gate} gate started (${progress.detail};${timeoutText||" no child timeout"}).\n`);
    const timeout=options.timeout?setTimeout(()=>{timedOut=true;if(!child.killed)child.kill("SIGTERM")},options.timeout):undefined;
    if(child.stdout){child.stdout.setEncoding("utf8");child.stdout.on("data",chunk=>{stdout+=chunk})}
    if(child.stderr){child.stderr.setEncoding("utf8");child.stderr.on("data",chunk=>{stderr+=chunk})}
    child.on("error",error=>{
      if(timeout)clearTimeout(timeout);
      if(progressTimer)clearInterval(progressTimer);
      if(!settled){settled=true;resolve({status:null,stdout,stderr:trimLog(`${stderr}\n${error.message||String(error)}`),error})}
    });
    child.on("close",(code,signal)=>{
      if(timeout)clearTimeout(timeout);
      if(progressTimer)clearInterval(progressTimer);
      if(!settled){settled=true;const status=timedOut?124:code;const timeoutMessage=timedOut?`\nCommand timed out after ${options.timeout}ms.`:"";resolve({status,signal,stdout,stderr:`${stderr}${timeoutMessage}`.trim()})}
    });
    if(options.input!==undefined&&child.stdin)child.stdin.write(options.input);
    if(child.stdin)child.stdin.end();
  })
}
function appendQualityOption(args,key,value){if(value===undefined||value===null||value==="")return;args.push(`--${key}`,String(value))}
function appendQualityBoolean(args,key,value){if(value)args.push(`--${key}`)}
function readObjective(options,cwd=process.cwd()){if(options.objectiveStdin)return fs.readFileSync(0,"utf8");if(options.objectiveFile)return fs.readFileSync(path.resolve(cwd,String(options.objectiveFile)),"utf8");if(options.objective)return String(options.objective);return DEFAULT_OBJECTIVE}
function scoreAppliesToForScope(scope){return scope==="full"?"entire-project":scope==="paths"?"selected-paths":"changed-files"}
function emptyScopeGates(options){const gates=[];if(options.semantic)gates.push({name:"semantic",command:null,exitCode:0,status:"APPROVED",score:100,skipped:true,message:"No files matched the requested scope after ignore rules."});if(options.quality)gates.push({name:"quality",command:null,exitCode:0,status:"APPROVED",score:100,skipped:true,message:"No files matched the requested scope after ignore rules."});return gates}
function finalizeSummary(summary,options){const scores=[summary.qualityScore,summary.semanticScore].filter(score=>typeof score==="number");summary.finalScore=scores.length?Math.min(...scores):null;if(summary.errors.length)summary.status="ERROR";else if(summary.finalScore===null)summary.status="NEEDS_CHANGES";else if(summary.baseline&&summary.baseline.newFindingsCount===0&&summary.baseline.existingFindingsCount>0)summary.status="APPROVED";else summary.status=summary.finalScore>=options.threshold?"APPROVED":"NEEDS_CHANGES";summary.finishedAt=new Date().toISOString()}
function writeSummary(outputDir,summary,options){fs.mkdirSync(outputDir,{recursive:true});const jsonPath=path.join(outputDir,"summary.json");const mdPath=path.join(outputDir,"summary.md");summary.reports.summaryJson=jsonPath;summary.reports.summaryMarkdown=mdPath;fs.writeFileSync(jsonPath,`${JSON.stringify(summary,null,2)}\n`,"utf8");fs.writeFileSync(mdPath,renderSummaryMarkdown(summary),"utf8")}
function renderSummaryMarkdown(summary){return `# Code Approval Gates Report\n\nStatus: ${summary.status}\nScope: ${summary.scope}\nScore applies to: ${summary.scoreAppliesTo||"n/a"}\nMode: ${summary.mode}\nThreshold: ${summary.threshold}\nFinal score: ${summary.finalScore??"n/a"}\nQuality score: ${summary.qualityScore??"n/a"}\nSemantic score: ${summary.semanticScore??"n/a"}\nFiles analyzed: ${summary.scopeResolution?.fileCount??0}\nIgnored files: ${summary.scopeResolution?.ignoredCount??0}\n\n## Command\n\n\`\`\`bash\n${summary.commandEquivalent}\n\`\`\`\n\n## Reports\n\n- Summary JSON: ${summary.reports.summaryJson||"n/a"}\n- Quality JSON: ${summary.reports.qualityJson||"n/a"}\n- Semantic JSON: ${summary.reports.semanticJson||"n/a"}\n\n## Gates\n\n${summary.gates.map(gate=>`- ${gate.name}: ${gate.status} score=${gate.score??"n/a"} exit=${gate.exitCode}`).join("\n")||"- None"}\n\n## Errors\n\n${summary.errors.length?summary.errors.map(error=>`- ${error.code}: ${error.message}`).join("\n"):"- None"}\n`}
function exitWithSummary(summary,options,code){if(options.json)process.stdout.write(`${JSON.stringify(summary,null,2)}\n`);else process.stdout.write(renderSummaryMarkdown(summary));return code}
function handleBaseline(cwd,parsed){const subcommand=parsed.positional[0]||"help";const baselineRawOptions=subcommand==="create"&&!parsed.options.scope?{...parsed.options,scope:"full"}:parsed.options;const options=normalizedOptions(cwd,baselineRawOptions);const baselineTarget=String(parsed.options.baseline||parsed.options.output||options.baseline?.path||DEFAULT_BASELINE_OUTPUT);const baselinePath=path.resolve(cwd,baselineTarget);if(subcommand==="create"){const reportOutput=String(parsed.options.reportOutput||DEFAULT_BASELINE_REPORT_OUTPUT);const reportPath=path.resolve(cwd,String(parsed.options.fromReport||path.join(reportOutput,"summary.json")));let scan=null;if(!parsed.options.fromReport&&(parsed.options.refresh||!fs.existsSync(reportPath))){scan=runBaselineSourceScan(cwd,{...options,...parsed.options,scope:options.scope||"full",output:reportOutput,format:parsed.options.format||options.format||"json,md",noInteractive:true,nonBlocking:true});}if(!fs.existsSync(reportPath)){return fail(options,4,"BASELINE_SOURCE_MISSING",`Baseline source report not found: ${reportPath}`,"Run code-approval-gates run --scope full first, pass --from-report <summary.json>, or rerun baseline create without --from-report so it can generate a source scan.");}const source=readJson(reportPath);const baseline=buildBaseline(source,cwd,options);baseline.sourceReport=reportPath;if(scan)baseline.sourceScan=scan;fs.mkdirSync(path.dirname(baselinePath),{recursive:true});fs.writeFileSync(baselinePath,`${JSON.stringify(baseline,null,2)}\n`,"utf8");writeHumanOrJson(options,baseline,`Baseline created: ${baselinePath}\nSource report: ${reportPath}\nFindings: ${baseline.findings.length}\n`);return 0}if(subcommand==="check"){const baseline=loadBaseline(baselinePath);writeHumanOrJson(options,baseline,`Baseline: ${baseline.findings.length} findings\nCreated at: ${baseline.createdAt}\n`);return 0}return fail(options,2,"UNKNOWN_BASELINE_COMMAND",`Unknown baseline command: ${subcommand}`,"Use code-approval-gates baseline create|check.")}
function buildBaselineSourceScanArgs(options){
  const args=[__filename,"run","--scope",String(options.scope||"full"),"--format",String(options.format||"json,md"),"--output",String(options.output||DEFAULT_BASELINE_REPORT_OUTPUT),"--threshold",String(options.threshold||DEFAULT_THRESHOLD),"--no-interactive","--non-blocking"];
  const semanticEnabled=!(options.noSemantic||options.semantic===false);
  if(options.json)args.push("--json");
  if(options.noSemantic||options.semantic===false)args.push("--no-semantic");
  if(options.noQuality||options.quality===false)args.push("--no-quality");
  if(semanticEnabled&&options.provider)args.push("--provider",String(options.provider));
  if(semanticEnabled&&options.model)args.push("--model",String(options.model));
  if(semanticEnabled&&options.reasoningEffort)args.push("--reasoning-effort",String(options.reasoningEffort));
  if(semanticEnabled&&options.codexSandbox)args.push("--codex-sandbox",String(options.codexSandbox));
  if(semanticEnabled&&options.codexBypassSandbox===true)args.push("--codex-bypass-sandbox");
  if(semanticEnabled&&options.codexBypassSandbox===false)args.push("--no-codex-bypass-sandbox");
  if(semanticEnabled&&options.codexSkipGitRepoCheck===true)args.push("--codex-skip-git-repo-check");
  if(semanticEnabled&&options.codexSkipGitRepoCheck===false)args.push("--no-codex-skip-git-repo-check");
  if(semanticEnabled&&options.objective)args.push("--objective",String(options.objective));
  if(semanticEnabled&&options.objectiveFile)args.push("--objective-file",String(options.objectiveFile));
  if(semanticEnabled&&options.objectiveStdin)args.push("--objective-stdin");
  if(String(options.scope||"full")==="paths")for(const item of options.paths||[])args.push("--path",item);
  for(const item of options.excludes||[])args.push("--exclude",item);
  for(const item of options.includes||[])args.push("--include",item);
  for(const item of options.ignoreFiles||[])args.push("--ignore-file",item);
  return args;
}
function runBaselineSourceScan(cwd,options){const semanticEnabled=!(options.noSemantic||options.semantic===false);const childOptions=options.objectiveStdin?semanticEnabled?{...options,objective:fs.readFileSync(0,"utf8"),objectiveStdin:false}:{...options,objectiveStdin:false}:options;const args=buildBaselineSourceScanArgs(childOptions);const result=spawnSync(process.execPath,args,{cwd,encoding:"utf8",errors:"replace",timeout:Number(options.baselineTimeoutMs||0)||undefined,stdio:options.json?"pipe":"inherit"});return{command:commandForDisplay(process.execPath,args),exitCode:result.status??null,stdout:options.json?trimLog(result.stdout):undefined,stderr:options.json?trimLog(result.stderr):undefined}}
function buildBaseline(summary,cwd,options){const findings=[];if(summary?.reports?.qualityJson&&fs.existsSync(summary.reports.qualityJson))findings.push(...extractFindingFingerprints(readJson(summary.reports.qualityJson),"quality"));if(summary?.reports?.semanticJson&&fs.existsSync(summary.reports.semanticJson))findings.push(...extractFindingFingerprints(readJson(summary.reports.semanticJson),"semantic"));return{schemaVersion:1,createdAt:new Date().toISOString(),cwd,scope:options.scope,findings:[...new Map(findings.map(item=>[item.fingerprint,item])).values()]}}
function loadBaseline(filePath){if(!fs.existsSync(filePath))throwUsage(`Baseline not found: ${filePath}`);return readJson(filePath)}
function compareBaseline(baseline,summary){const current=[];if(summary.reports.qualityJson&&fs.existsSync(summary.reports.qualityJson))current.push(...extractFindingFingerprints(readJson(summary.reports.qualityJson),"quality"));if(summary.reports.semanticJson&&fs.existsSync(summary.reports.semanticJson))current.push(...extractFindingFingerprints(readJson(summary.reports.semanticJson),"semantic"));const baseSet=new Set((baseline.findings||[]).map(item=>item.fingerprint));const currentSet=new Set(current.map(item=>item.fingerprint));return{baselineCount:baseSet.size,currentCount:currentSet.size,newFindingsCount:current.filter(item=>!baseSet.has(item.fingerprint)).length,existingFindingsCount:current.filter(item=>baseSet.has(item.fingerprint)).length,resolvedFindingsCount:[...baseSet].filter(fingerprint=>!currentSet.has(fingerprint)).length}}
function extractFindingFingerprints(report,gate){const findings=Array.isArray(report?.findings)?report.findings:[];return findings.map(finding=>{const pathValue=finding.path||finding.file||finding.location?.path||"";const rule=finding.rule||finding.ruleId||finding.category||finding.tool||"";const line=finding.line||finding.location?.line||"";const message=finding.message||finding.title||finding.requiredFix||"";const fingerprint=[gate,finding.tool||"",rule,pathValue,line,message].join("|");return{gate,fingerprint,path:pathValue,rule,line,message}})}
function handleInit(cwd,options){const created=ensureDefaultProjectFiles(cwd,options.fix!==false);writeHumanOrJson(options,{status:"OK",created},`Initialized Code Approval Gates\n${created.map(item=>`- ${item}`).join("\n")}\n`);return 0}
function ensureDefaultProjectFiles(cwd,allowCreate=true){
  const created=[];
  const files={
    [DEFAULT_CONFIG]:JSON.stringify({
      threshold:DEFAULT_THRESHOLD,
      defaultScope:"changed",
      paths:[],
      excludes:[],
      includes:[],
      ignoreFiles:[],
      format:"json,md",
      output:DEFAULT_OUTPUT,
      quality:{enabled:true},
      semantic:{
        enabled:true,
        provider:"codex-cli",
        model:"gpt-5.5",
        reasoningEffort:"high",
        timeoutMs:DEFAULT_SEMANTIC_TIMEOUT_MS,
        codexSandbox:"danger-full-access",
        codexBypassSandbox:false,
        codexSkipGitRepoCheck:true
      },
      baseline:{path:DEFAULT_BASELINE_OUTPUT}
    },null,2)+"\n",
    [COMMON_IGNORE]:"# Shared ignore file for Code Approval Gates.\n# Syntax follows the same style as .gitignore.\n\n.git/\nnode_modules/\ncoverage/\ndist/\nbuild/\nout/\ntmp/\ntemp/\n\n.quality/\n.semantic/\n\n*.log\n*.tmp\n",
    [QUALITY_IGNORE]:"# Quality Gate specific ignore file.\n# Syntax follows the same style as .gitignore.\n\n.git/\nnode_modules/\ncoverage/\ndist/\nbuild/\nout/\ntmp/\ntemp/\n\n.quality/\n\nplaywright-report/\ntest-results/\nprojects/**/artifacts/\n\n*.log\n*.tmp\n",
    [SEMANTIC_IGNORE]:"# Semantic Gate specific ignore file.\n# Syntax follows the same style as .gitignore.\n\n.git/\nnode_modules/\ncoverage/\ndist/\nbuild/\nout/\ntmp/\ntemp/\n\n.semantic/\n\npackage-lock.json\npnpm-lock.yaml\nyarn.lock\n*.min.js\ndocs/archive/**\n\n*.log\n*.tmp\n"
  };
  for(const[name,content]of Object.entries(files)){
    const filePath=path.join(cwd,name);
    if(!fs.existsSync(filePath)&&allowCreate){
      fs.writeFileSync(filePath,content,"utf8");
      created.push(name);
    }
  }
  fs.mkdirSync(path.join(cwd,".quality","reports"),{recursive:true});
  fs.mkdirSync(path.join(cwd,".quality","baseline"),{recursive:true});
  return created;
}
async function handleDoctor(cwd,parsed){
  const options=parsed.options;
  const focus=parsed.positional[0]||"all";
  if(!["all","quality","semantic","gitlab"].includes(focus))return fail(options,2,"UNKNOWN_DOCTOR_FOCUS",`Unknown doctor focus: ${focus}`,"Use code-approval-gates doctor quality|semantic|gitlab.");
  const projectConfig=loadProjectConfig(cwd);
  const semanticConfig=projectConfig.semantic && typeof projectConfig.semantic==="object" ? projectConfig.semantic : {};
  const semanticProvider=String(options.provider||semanticConfig.provider||"codex-cli");
  const semanticModel=String(options.model||semanticConfig.model||"");
  const semanticApiKeyEnv=options.apiKeyEnv||semanticConfig.apiKeyEnv;
  const checks=[];
  if(["all","quality","semantic","gitlab"].includes(focus)){
    checks.push(checkCommand("node",["--version"],"node"));
    checks.push(checkCommand("npm",["--version"],"npm"));
    checks.push(checkCommand("git",["--version"],"git"));
    checks.push(checkWritable(cwd));
  }
  if(["all","quality"].includes(focus)){
    const dockerCheck=checkCommand("docker",["version","--format","{{.Server.Version}}"],"docker-daemon",true);
    const localSidecarCheck=checkLocalQualitySidecar();
    checks.push(dockerCheck);
    if(isCheckOk(dockerCheck))checks.push(checkDockerImage("code-approval-gates/quality-sidecar:latest"));
    else checks.push({name:"quality-sidecar-image",status:"SKIPPED",message:"Docker unavailable; local offline sidecar can be used instead."});
    checks.push(localSidecarCheck);
    checks.push(checkQualityRuntime(dockerCheck,localSidecarCheck));
    checks.push(checkFile(QUALITY_BIN,"quality-wrapper"));
  }
  if(["all","semantic"].includes(focus)){
    checks.push(...checkSemanticProviderConfig(semanticProvider,semanticModel,semanticApiKeyEnv));
    if(semanticProvider==="codex-cli")checks.push(checkCodexApiNetwork());
    checks.push(checkFile(SEMANTIC_BIN,"semantic-wrapper"));
  }
  if(["all","gitlab"].includes(focus)){
    checks.push({name:"gitlab-ci",status:process.env.GITLAB_CI?"OK":"SKIPPED",message:process.env.GITLAB_CI?"GitLab CI detected.":"Not running in GitLab CI."});
    checks.push({name:"gitlab-mr-vars",status:process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME?"OK":"WARNING",message:process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME?"MR target branch available.":"MR variables not detected."});
  }
  let fixed=[];
  let runFixes=Boolean(options.fix);
  if(runFixes&&!options.yes&&detectExecutionMode(options).interactive){
    const confirmed=await confirmPrompt("Doctor --fix can create files, install local dependencies, and build local artifacts. Continue? [y/N] ");
    if(!confirmed){
      runFixes=false;
      checks.push({name:"fix-confirmation",status:"SKIPPED",message:"Fix actions skipped by user."});
    }
  }
  if(runFixes){
    fixed=ensureDefaultProjectFiles(cwd,true);
    if(fixed.length)checks.push({name:"project-files",status:"FIXED",message:`Created ${fixed.join(", ")}`});
    if(["all","semantic"].includes(focus)&&!fs.existsSync(path.join(ROOT,"semantic-gate","node_modules"))){
      checks.push(runFixCommand("semantic-deps","npm",["--prefix",path.join(ROOT,"semantic-gate"),"install","--ignore-scripts","--workspaces=false","--dry-run=false"],ROOT));
    }
    if(["all","semantic"].includes(focus)&&!fs.existsSync(SEMANTIC_BIN)){
      checks.push(runFixCommand("semantic-build","npm",["--prefix",path.join(ROOT,"semantic-gate"),"run","build","--workspaces=false"],ROOT));
    }
    if(["all","quality"].includes(focus)&&isCheckOk(checkCommand("docker",["version","--format","{{.Server.Version}}"],"docker-daemon"))&&!isCheckOk(checkDockerImage("code-approval-gates/quality-sidecar:latest"))){
      checks.push(runFixCommand("quality-sidecar-image","docker",["build","-t","code-approval-gates/quality-sidecar:latest",path.join(ROOT,"quality-gate")],ROOT));
    }
  }
  if(options.fixNetwork){
    if(["all","semantic"].includes(focus))checks.push(...fixCodexNetworkAccess(cwd,options));
    else checks.push({name:"codex-api-firewall",status:"SKIPPED",message:"Network fix only applies to doctor semantic or doctor all."});
  }
  if(options.installGlobal){
    let runInstall=true;
    if(!options.yes&&detectExecutionMode(options).interactive){
      runInstall=await confirmPrompt("Doctor --install-global runs npm install -g for this package. Continue? [y/N] ");
    }
    if(runInstall)checks.push(runFixCommand("global-install","npm",["install","-g",ROOT],ROOT));
    else checks.push({name:"global-install",status:"SKIPPED",message:"Global install skipped by user."});
  }
  const hasError=checks.some(check=>check.status==="ERROR");
  const payload={status:hasError?"ERROR":checks.some(check=>check.status==="WARNING")?"WARNING":"OK",focus,checks,fixed};
  if(options.json)process.stdout.write(`${JSON.stringify(payload,null,2)}\n`);else process.stdout.write(renderDoctor(payload));
  return hasError?3:0;
}
async function confirmPrompt(question){
  const rl=readline.createInterface({input:process.stdin,output:process.stdout});
  try{
    const answer=await new Promise(resolve=>rl.question(question,resolve));
    return /^(y|yes|s|sim)$/i.test(String(answer||"").trim());
  }finally{
    rl.close();
  }
}function checkCommand(command,args,name,optional=false){const result=spawnPortable(command,args,{encoding:"utf8",errors:"replace",timeout:15000});if(result.status===0)return{name,status:"OK",message:trimLog(result.stdout||result.stderr)};return{name,status:optional?"WARNING":"ERROR",message:result.error?result.error.message:trimLog(result.stderr||result.stdout||`${command} failed`)}}
function checkDockerImage(image){const result=spawnSync("docker",["image","inspect",image],{encoding:"utf8",errors:"replace",timeout:15000});if(result.status===0)return{name:"quality-sidecar-image",status:"OK",message:image};return{name:"quality-sidecar-image",status:"WARNING",message:`Image not found locally: ${image}`}}
function semanticProviderEnvVar(provider,explicitProviderEnv){
  if(explicitProviderEnv){return explicitProviderEnv;}
  const mapped={openrouter:"OPENROUTER_API_KEY",openai:"OPENAI_API_KEY","openai-compatible":"SEMANTIC_GATE_API_KEY","opencode-api":"OPENCODE_API_KEY",anthropic:"ANTHROPIC_API_KEY","claude":"ANTHROPIC_API_KEY","claude-api":"ANTHROPIC_API_KEY",gemini:"GEMINI_API_KEY","gemini-api":"GEMINI_API_KEY",ollama:"OLLAMA_API_KEY",mock:""};
  return mapped[provider]||"";
}
function semanticProviderNeedsModel(provider){
  return !["mock","ollama","codex-cli","claude-code","gemini-cli","opencode"].includes(provider);
}
function checkCodexApiNetwork(){
  const script=[
    'const tls=require("node:tls");',
    'const host="api.openai.com";',
    'let done=false;',
    'const socket=tls.connect({host,port:443,servername:host,timeout:5000},()=>finish(0,"api.openai.com:443 reachable"));',
    'function finish(code,message){if(done)return;done=true;if(code===0)console.log(message);else console.error(message);socket.destroy();process.exit(code);}',
    'socket.on("error",error=>finish(2,error.message||String(error)));',
    'socket.setTimeout(5000,()=>finish(2,"timeout connecting to api.openai.com:443"));'
  ].join("");
  const result=spawnSync(process.execPath,["-e",script],{encoding:"utf8",errors:"replace",timeout:7000,windowsHide:true});
  if(result.status===0)return{name:"codex-api-network",status:"OK",message:trimLog(result.stdout||"api.openai.com:443 reachable")};
  return{name:"codex-api-network",status:"WARNING",message:`Cannot confirm outbound TLS to api.openai.com:443 (${trimLog(result.stderr||result.stdout||result.error?.message||"network probe failed")}). If local Windows Firewall is the blocker, run code-approval-gates doctor semantic --fix-network --yes from an elevated PowerShell.`};
}
function fixCodexNetworkAccess(cwd,options){
  if(process.platform!=="win32")return[{name:"codex-api-firewall",status:"SKIPPED",message:"Automatic firewall repair is implemented only for Windows. Ensure outbound TCP 443 to api.openai.com is allowed for the Codex runtime."}];
  if(!isWindowsAdmin())return[{name:"codex-api-firewall-admin",status:"ERROR",message:`Administrator PowerShell is required to create firewall rules. Open PowerShell as Administrator and run: ${elevatedDoctorCommand(cwd,options)}`}];
  const programs=resolveCodexNetworkPrograms();
  if(!programs.length)return[{name:"codex-api-firewall",status:"ERROR",message:"No executable runtime was found for Codex/Node firewall rules."}];
  const checks=programs.map(ensureCodexFirewallRule);
  checks.push(checkCodexApiNetwork());
  return checks;
}
function isWindowsAdmin(){
  const result=spawnSync("net",["session"],{stdio:"ignore",windowsHide:true,timeout:5000});
  return result.status===0;
}
function elevatedDoctorCommand(cwd,options){
  const args=[process.execPath,__filename,"--cwd",cwd,"doctor","semantic","--fix-network","--yes"];
  if(options.json)args.push("--json");
  if(options.noInteractive||options.json||options.ci)args.push("--no-interactive");
  return commandForDisplay(args[0],args.slice(1));
}
function resolveCodexNetworkPrograms(){
  const programs=new Set();
  addExecutable(programs,process.execPath);
  const where=spawnSync("where.exe",["codex"],{encoding:"utf8",errors:"replace",timeout:5000,windowsHide:true});
  for(const entry of String(where.stdout||"").split(/\r?\n/).map(item=>item.trim()).filter(Boolean)){
    if(/\.exe$/i.test(entry))addExecutable(programs,entry);
    if(/\.cmd$/i.test(entry))addExecutable(programs,path.join(path.dirname(entry),"node.exe"));
  }
  return [...programs];
}
function addExecutable(programs,filePath){
  if(filePath&&/\.exe$/i.test(filePath)&&fs.existsSync(filePath))programs.add(path.resolve(filePath));
}
function ensureCodexFirewallRule(program){
  const ruleName=`Code Approval Gates Codex API ${hashPath(program)} (${path.basename(program)})`;
  const script=[
    "$ErrorActionPreference='Stop'",
    `$program=${psSingleQuote(program)}`,
    `$name=${psSingleQuote(ruleName)}`,
    "$existing=Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue",
    "if($existing){Write-Output \"exists: $name\"; exit 0}",
    "New-NetFirewallRule -DisplayName $name -Direction Outbound -Program $program -Action Allow -Profile Any -Protocol TCP -RemotePort 443 | Out-Null",
    "Write-Output \"created: $name\""
  ].join(";");
  const result=spawnSync("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-Command",script],{encoding:"utf8",errors:"replace",timeout:30000,windowsHide:true});
  if(result.status===0)return{name:"codex-api-firewall",status:"FIXED",message:trimLog(`${trimLog(result.stdout)} for ${program}`)};
  return{name:"codex-api-firewall",status:"ERROR",message:trimLog(result.stderr||result.stdout||result.error?.message||`Failed to create firewall rule for ${program}`),exitCode:result.status??1};
}
function psSingleQuote(value){
  return `'${String(value).replace(/'/g,"''")}'`;
}
function hashPath(value){
  return crypto.createHash("sha1").update(String(value).toLowerCase()).digest("hex").slice(0,8);
}
function semanticProviderCommand(provider){
  const commands={
    "codex-cli":"codex",
    "claude-code":"claude",
    "gemini-cli":"gemini",
    opencode:"opencode",
  };
  return commands[provider];
}
function semanticCommandProviderChecks(provider){
  const providerCommand=semanticProviderCommand(provider);
  if(!providerCommand)return [];
  return [checkCommand(providerCommand,["--version"],`${providerCommand} installed`,false)];
}
function checkSemanticProviderConfig(provider,model,apiKeyEnv){
  const checks=[];
  const normalized=String(provider||"");
  if(!normalized){
    checks.push({name:"semantic-provider-config",status:"WARNING",message:"No semantic provider configured."});
    return checks;
  }
  if(normalized==="mock"){
    checks.push({name:"semantic-provider-config",status:"OK",message:"Mock provider selected."});
    return checks;
  }
  checks.push({name:"semantic-provider-config",status:"OK",message:`Provider: ${normalized}`});
  const command=semanticProviderCommand(normalized);
  if(command){
    checks.push(...semanticCommandProviderChecks(normalized));
    return checks;
  }
  if(semanticProviderNeedsModel(normalized)&&!model){
    checks.push({name:"semantic-provider-model",status:"WARNING",message:`No model configured for ${normalized}.`});
  }
  const envVar=semanticProviderEnvVar(normalized,apiKeyEnv);
  if(envVar){
    if(process.env[envVar])checks.push({name:"semantic-provider-env",status:"OK",message:`Found env ${envVar}`});
    else checks.push({name:"semantic-provider-env",status:"WARNING",message:`Missing env ${envVar} (set it or run: semantic-gate auth set ${normalized} --key-stdin).`});
  }
  return checks;
}
function isCheckOk(check){return check.status==="OK"||check.status==="FIXED"}
function runFixCommand(name,command,args,cwd){const result=spawnPortable(command,args,{cwd,encoding:"utf8",errors:"replace",timeout:120000});if(result.status===0)return{name,status:"FIXED",message:trimLog(result.stdout||`${command} ${args.join(" ")}`)};return{name,status:"ERROR",message:trimLog(result.stderr||result.stdout||`${command} failed`),exitCode:result.status??1}}
function spawnPortable(command,args,options){const result=spawnSync(command,args,options);if(!result.error||result.error.code!=="ENOENT"||process.platform!=="win32")return result;const cmdRetry=spawnViaCmd(command,args,options);if(!cmdRetry.error)return cmdRetry;for(const candidate of [`${command}.cmd`,`${command}.exe`]){const retry=spawnViaCmd(candidate,args,options);if(!retry.error)return retry}const where=spawnSync("where.exe",[command],{encoding:"utf8",errors:"replace",timeout:5000});for(const line of String(where.stdout||"").split(/\r?\n/).map(item=>item.trim()).filter(Boolean)){if(line.toLowerCase().endsWith(".cmd")||line.toLowerCase().endsWith(".exe")){const retry=spawnViaCmd(line,args,options);if(!retry.error)return retry}if(line.toLowerCase().endsWith(".ps1")){const retry=spawnSync("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",line,...args],options);if(!retry.error)return retry}}return result}
function spawnViaCmd(command,args,options){return spawnSync("cmd.exe",["/d","/s","/c",commandForDisplay(command,args)],options)}
function checkFile(filePath,name){return fs.existsSync(filePath)?{name,status:"OK",message:filePath}:{name,status:"ERROR",message:`Missing ${filePath}`}}
function pythonCommand(){return process.env.PYTHON||(process.platform==="win32"?"python":"python3")}
function checkLocalQualitySidecar(){if(!fs.existsSync(path.join(QUALITY_SIDECAR_DIR,"quality_sidecar","cli.py")))return{name:"quality-local-sidecar",status:"WARNING",message:`Missing ${QUALITY_SIDECAR_DIR}`};const env={...process.env,PYTHONPATH:process.env.PYTHONPATH?`${QUALITY_SIDECAR_DIR}${path.delimiter}${process.env.PYTHONPATH}`:QUALITY_SIDECAR_DIR};const result=spawnPortable(pythonCommand(),["-c","import quality_sidecar"],{encoding:"utf8",errors:"replace",timeout:15000,env});if(result.status===0)return{name:"quality-local-sidecar",status:"OK",message:"Bundled Python sidecar is importable."};return{name:"quality-local-sidecar",status:"WARNING",message:trimLog(result.stderr||result.stdout||"Bundled Python sidecar is not importable.")}}
function checkQualityRuntime(dockerCheck,localSidecarCheck){if(isCheckOk(dockerCheck))return{name:"quality-runtime",status:"OK",message:"Docker runtime is available for full Quality Gate scans."};if(isCheckOk(localSidecarCheck))return{name:"quality-runtime",status:"OK",message:"Local offline Quality Gate runtime is available."};return{name:"quality-runtime",status:"ERROR",message:"Neither Docker nor the local Python sidecar is available for Quality Gate scans."}}
function checkWritable(cwd){const dir=path.join(cwd,".quality","doctor");try{fs.mkdirSync(dir,{recursive:true});const probe=path.join(dir,`.probe-${Date.now()}`);fs.writeFileSync(probe,"ok","utf8");fs.unlinkSync(probe);return{name:"reports-writable",status:"OK",message:dir}}catch(error){return{name:"reports-writable",status:"ERROR",message:error.message}}}
function renderDoctor(payload){return`Code Approval Gates Doctor\nStatus: ${payload.status}\nFocus: ${payload.focus}\n\n${payload.checks.map(check=>`[${check.status}] ${check.name}: ${check.message}`).join("\n")}\n`}
function handleReport(cwd,parsed){const subcommand=parsed.positional[0]||"summary";const options=normalizedOptions(cwd,parsed.options);const reportDir=String(parsed.options.reportDir||options.output);const summaryPath=path.resolve(cwd,reportDir,"summary.json");if(subcommand==="summary"){if(!fs.existsSync(summaryPath))return fail(options,2,"REPORT_NOT_FOUND",`Report not found: ${summaryPath}`,"Run code-approval-gates run first or pass --report-dir <dir>.");const summary=readJson(summaryPath);writeHumanOrJson(options,summary,renderSummaryMarkdown(summary));return 0}if(subcommand==="open"||subcommand==="path"){writeHumanOrJson(options,{reportPath:summaryPath},`${summaryPath}\n`);return 0}return fail(options,2,"UNKNOWN_REPORT_COMMAND",`Unknown report command: ${subcommand}`,"Use code-approval-gates report summary|open|path.")}
function handleConfig(cwd,parsed){
  const subcommand=parsed.positional[0]||"get";
  const key=parsed.positional[1];
  const value=parsed.positional[2];
  const configPath=path.join(cwd,DEFAULT_CONFIG);
  const config=loadProjectConfig(cwd);
  if(subcommand==="get"){
    const payload=key?getPath(config,key):config;
    writeHumanOrJson(parsed.options,payload,`${JSON.stringify(payload,null,2)}\n`);
    return 0;
  }
  if(subcommand==="set"){
    if(!key||value===undefined)return fail(parsed.options,2,"MISSING_CONFIG_VALUE","Usage: code-approval-gates config set <key> <value>","Pass both key and value.");
    setPath(config,key,parseScalar(value));
    fs.writeFileSync(configPath,`${JSON.stringify(config,null,2)}\n`,"utf8");
    writeHumanOrJson(parsed.options,{status:"OK",configPath},`Updated ${configPath}\n`);
    return 0;
  }
  if(subcommand==="path"){
    const payload={
      path:configPath,
      exists:fs.existsSync(configPath),
      parseable:!Boolean(config && config.configError),
      parseError:config && config.configError ? String(config.configError) : null
    };
    writeHumanOrJson(parsed.options,payload,`${configPath}\n`);
    return 0;
  }
  return fail(parsed.options,2,"UNKNOWN_CONFIG_COMMAND",`Unknown config command: ${subcommand}`,"Use code-approval-gates config get|set|path.");
}
function getPath(object,key){return String(key).split(".").reduce((acc,part)=>acc==null?undefined:acc[part],object)}
function setPath(object,key,value){const parts=String(key).split(".");let current=object;for(const part of parts.slice(0,-1)){if(!current[part]||typeof current[part]!=="object")current[part]={};current=current[part]}current[parts[parts.length-1]]=value}
async function runWizard(cwd,baseOptions){
  const rl=readline.createInterface({input:process.stdin,output:process.stdout});
  const ask=q=>new Promise(resolve=>rl.question(q,resolve));
  const askTrim=async label=>(await ask(label)).trim();
  const readCsv=value=>value.split(",").map(item=>item.trim()).filter(Boolean);
  const confirmYesNo=async label=>/^(s|sim|y|yes)$/i.test((await ask(label)).trim());

  try{
    process.stdout.write("Code Approval Gates\n\n");
    const action=await choose(rl,"O que voce quer fazer?",[["run","Rodar analise de gates"],["quality","Rodar apenas Quality Gate"],["semantic","Rodar apenas Semantic Gate"],["baseline","Criar baseline"],["report","Consultar relatorio"],["config","Consultar ou alterar config"],["doctor","Verificar ambiente com Doctor"]]);

    if(action==="doctor"){
      const focus=await choose(rl,"Qual area do Doctor?",[["all","Ambiente completo"],["quality","Quality Gate"],["semantic","Semantic Gate"],["gitlab","GitLab CI"]]);
      const doctorOptions={...baseOptions,interactive:true,focus};
      doctorOptions.fix=await confirmYesNo("Tentar corrigir/instalar itens faltantes se for seguro? [s/N] ");
      if(doctorOptions.fix)doctorOptions.yes=true;
      const equivalent=buildEquivalentCommand("doctor",doctorOptions);
      process.stdout.write("\nComando equivalente:\n"+equivalent+"\n\n");
      const confirm=await ask("Executar agora? [S/n] ");
      if(/^n/i.test(confirm.trim()))return 0;
      return handleDoctor(cwd,{positional:focus==="all"?[]:[focus],options:doctorOptions});
    }

    if(action==="report"){
      const reportAction=await choose(rl,"Qual comando de relatorio?",[["summary","Resumo"],["path","Caminho do resumo"],["open","Mostrar caminho"]]);
      const reportDir=await askTrim("Diretorio do relatorio [.quality/reports/latest]: ");
      const options={...baseOptions,reportDir:reportDir||".quality/reports/latest",interactive:true};
      const reportEquivalent=commandForDisplay("code-approval-gates",["report",reportAction].concat(options.reportDir?[`--report-dir`,options.reportDir]:[]));
      process.stdout.write("\nComando equivalente:\n"+reportEquivalent+"\n\n");
      const confirm=await ask("Executar agora? [S/n] ");
      if(/^n/i.test(confirm.trim()))return 0;
      return handleReport(cwd,{positional:[reportAction],options});
    }

    if(action==="config"){
      const configAction=await choose(rl,"Acao de config?",[["get","Consultar"],["set","Alterar"]]);
      let key=await askTrim("Chave (vazia para consultar tudo): ");
      const options={...baseOptions,interactive:true};
      if(configAction==="set"&&!key){
        key=await askTrim("Chave obrigatoria para set: ");
      }
      const hasCommandFlags=options.noInteractive?["--no-interactive"]:options.json?["--json"]:[];
      const baseConfigCommand=["config",configAction];
      if(key)baseConfigCommand.push(key);

      if(configAction==="set"){
        if(!key)return fail(options,2,"MISSING_CONFIG_VALUE","Usage: code-approval-gates config set <key> <value>","Informe uma chave e um valor para set.");
        const value=await askTrim("Valor: ");
        if(!value)return fail(options,2,"MISSING_CONFIG_VALUE","Usage: code-approval-gates config set <key> <value>","Informe uma chave e um valor para set.");
        const setCommand=commandForDisplay("code-approval-gates",["config","set",key,value,...hasCommandFlags]);
        process.stdout.write("\nComando equivalente:\n"+setCommand+"\n\n");
        const confirm=await ask("Executar agora? [S/n] ");
        if(/^n/i.test(confirm.trim()))return 0;
        return handleConfig(cwd,{command:"config",positional:["set",key,value],options});
      }

      const positional=["get"];
      if(key)positional.push(key);
      const configCommand=commandForDisplay("code-approval-gates",[...baseConfigCommand,...hasCommandFlags]);
      process.stdout.write("\nComando equivalente:\n"+configCommand+"\n\n");
      const confirm=await ask("Executar agora? [S/n] ");
      if(/^n/i.test(confirm.trim()))return 0;
      return handleConfig(cwd,{command:"config",positional,options});
    }

    const scopeChoices=action==="baseline"?[["full","Projeto inteiro"],["changed","Alteracoes recentes do Git"],["paths","Diretorios/arquivos especificos"]]:[["changed","Alteracoes recentes do Git"],["full","Projeto inteiro"],["paths","Diretorios/arquivos especificos"]];
    const scope=await choose(rl,"Qual escopo analisar?",scopeChoices);
    const options={...baseOptions,scope,interactive:true};

    if(action==="run"){
      options.gate=await choose(rl,"Quais gates executar?",[["both","Quality + Semantic"],["quality","Apenas Quality Gate"],["semantic","Apenas Semantic Gate"]]);
    }

    if(scope==="paths"){
      const rawPaths=await askTrim("Paths separados por virgula: ");
      options.paths=readCsv(rawPaths);
    }

    const rawExcludes=await askTrim("Excludes temporarios separados por virgula [nenhum]: ");
    if(rawExcludes)options.excludes=readCsv(rawExcludes);

    const rawIncludes=await askTrim("Includes temporarios separados por virgula [nenhum]: ");
    if(rawIncludes)options.includes=readCsv(rawIncludes);

    const rawIgnoreFiles=await askTrim("Ignore files extras separados por virgula [nenhum]: ");
    if(rawIgnoreFiles)options.ignoreFiles=readCsv(rawIgnoreFiles);

    const threshold=await askTrim("Threshold ["+DEFAULT_THRESHOLD+"]: ");
    if(threshold)options.threshold=Number(threshold);

    if(action==="baseline"){
      const baselineOutput=await askTrim("Arquivo de baseline [.quality/baseline/baseline.json]: ");
      options.output=baselineOutput||DEFAULT_BASELINE_OUTPUT;
      const reportOutput=await askTrim("Output da analise fonte [.quality/reports/baseline-source]: ");
      options.reportOutput=reportOutput||DEFAULT_BASELINE_REPORT_OUTPUT;
    }else{
      const output=await askTrim("Output ["+DEFAULT_OUTPUT+"]: ");
      if(output)options.output=output;
    }

    const needsSemantic=action==="semantic"||(action==="run"&&(options.gate!=="quality"));
    if(needsSemantic){
      const objective=await askTrim("Objetivo semantico [padrao]: ");
      if(objective)options.objective=objective;
      const provider=await choose(rl,"Provider/modelo de IA",[["keep","Usar configuracao atual"],["codex-cli","codex-cli"],["openai","openai"],["anthropic","anthropic/claude"],["openrouter","openrouter"],["gemini","gemini"],["ollama","ollama"],["opencode","opencode"],["custom","Informar manualmente"]]);
      if(provider!=="keep"){
        options.provider=provider==="custom"?(await askTrim("Provider: ")):provider;
        const defaultModel=options.provider==="codex-cli"?"gpt-5.5":"";
        const model=await askTrim("Modelo"+(defaultModel?" ["+defaultModel+"]":"")+": ");
        if(model)options.model=model;
        else if(defaultModel)options.model=defaultModel;
        if(options.provider==="codex-cli"){
          const effort=await askTrim("Reasoning effort [high]: ");
          options.reasoningEffort=effort||"high";
        }
      }
    }

    const equivalent=buildEquivalentCommand(action,normalizedOptions(cwd,options));
    process.stdout.write("\nComando equivalente:\n"+equivalent+"\n\n");
    const confirm=await ask("Executar agora? [S/n] ");
    if(/^n/i.test(confirm.trim()))return 0;

    if(action==="baseline"){
      return handleBaseline(cwd,{positional:["create"],options});
    }

    const runQuality=action!=="semantic" && (action!=="run"||options.gate!=="semantic");
    const runSemantic=action!=="quality" && (action!=="run"||(options.gate==="semantic"||!options.gate||options.gate==="both"));
    return handleRun(cwd,{...options,quality:runQuality,semantic:runSemantic},action);
  }finally{
    rl.close();
  }
}

async function choose(rl,title,choices){process.stdout.write(`${title}\n`);choices.forEach(([,label],index)=>process.stdout.write(`${index+1}. ${label}\n`));const answer=await new Promise(resolve=>rl.question("> ",resolve));const index=Number(answer.trim()||"1")-1;return choices[index]?.[0]||choices[0][0]}
function buildEquivalentCommand(command,options){
  const base=command==="both"?"run":command;
  const args=["code-approval-gates"];
  if(base==="baseline")args.push("baseline","create");else args.push(base);
  if(base==="doctor"&&options.focus&&options.focus!=="all")args.push(String(options.focus));
  if(base==="doctor"){
    if(options.fix)args.push("--fix");
    if(options.fixNetwork)args.push("--fix-network");
    if(options.yes)args.push("--yes");
    if(options.installGlobal)args.push("--install-global");
  }
  if(base!=="doctor"){
    if(base==="run"&&options.gate)args.push("--gate",String(options.gate));
    args.push("--scope",options.scope||"changed");
    if(String(options.scope||"changed")==="paths")for(const item of options.paths||[])args.push("--path",item);
    for(const item of options.excludes||[])args.push("--exclude",item);
    for(const item of options.includes||[])args.push("--include",item);
    for(const item of options.ignoreFiles||[])args.push("--ignore-file",item);
    args.push("--threshold",String(options.threshold||DEFAULT_THRESHOLD));
    args.push("--format",options.format||"json,md");
    if(base==="baseline"){
      const baselineOutput=options.reportOutput&&options.output&&options.output!==DEFAULT_OUTPUT?options.output:DEFAULT_BASELINE_OUTPUT;
      args.push("--output",baselineOutput);
      args.push("--report-output",options.reportOutput||DEFAULT_BASELINE_REPORT_OUTPUT);
    }else{
      args.push("--output",options.output||DEFAULT_OUTPUT);
    }
  }
  if(options.provider)args.push("--provider",String(options.provider));
  if(options.model)args.push("--model",String(options.model));
  if(options.reasoningEffort)args.push("--reasoning-effort",String(options.reasoningEffort));
  if(options.codexSandbox)args.push("--codex-sandbox",String(options.codexSandbox));
  if(options.codexBypassSandbox===true)args.push("--codex-bypass-sandbox");
  if(options.codexBypassSandbox===false)args.push("--no-codex-bypass-sandbox");
  if(options.codexSkipGitRepoCheck===true)args.push("--codex-skip-git-repo-check");
  if(options.codexSkipGitRepoCheck===false)args.push("--no-codex-skip-git-repo-check");
  if(options.ci)args.push("--ci");
  if(options.noInteractive||options.json||options.ci)args.push("--no-interactive");
  if(options.json)args.push("--json");
  if(options.objective)args.push("--objective",String(options.objective));
  if(options.objectiveFile)args.push("--objective-file",String(options.objectiveFile));
  if(options.objectiveStdin)args.push("--objective-stdin");
  if(options.semantic===false)args.push("--no-semantic");
  if(options.quality===false)args.push("--no-quality");
  return commandForDisplay(args[0],args.slice(1));
}
function runCaptured(command,args,cwd){return spawnSync(command,args,{cwd,encoding:"utf8",errors:"replace",timeout:30000})}
function recordCommand(command,args,result){return{command:commandForDisplay(command,args),exitCode:result.status??null,stderr:trimLog(result.stderr||"")}}
function splitLines(text){return String(text||"").split(/\r?\n/).map(line=>line.trim()).filter(Boolean)}
function commandForDisplay(command,args){return[command,...args].map(part=>/[\s"']/.test(String(part))?`"${String(part).replace(/"/g,'\\"')}"`:String(part)).join(" ")}
function copyIfExists(source,target){if(!fs.existsSync(source)||fs.statSync(source).isDirectory())return null;if(path.resolve(source)===path.resolve(target))return target;fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);return target}
function copyDirIfExists(source,target){
  if(!fs.existsSync(source))return null;
  const resolvedSource=path.resolve(source);
  const resolvedTarget=path.resolve(target);
  const separator=path.sep;
  if(resolvedSource===resolvedTarget||resolvedTarget.startsWith(resolvedSource + separator))return resolvedTarget;
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const stat=fs.statSync(source);
  if(stat.isDirectory()){
    fs.rmSync(target,{recursive:true,force:true});
    fs.cpSync(source,target,{recursive:true});
  }else{
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.copyFileSync(source,target);
  }
  return target;
}
function readJson(filePath){return JSON.parse(fs.readFileSync(filePath,"utf8"))}
function trimLog(value){const text=String(value||"").trim();return text.length>4000?`${text.slice(0,1800)}\n...<truncated>...\n${text.slice(-1800)}`:text}
function toErrorObject(error){return{code:error.code||"ERROR",message:error.message||String(error)}}
function exitCodeForError(error){if(error.code==="USAGE")return 2;return 4}
function fail(options,exitCode,code,message,fix){const payload={schemaVersion:1,status:"ERROR",code,message,fix:fix||null,error:{code,message,fix:fix||null},exitCode};if(options.json)process.stdout.write(`${JSON.stringify(payload,null,2)}\n`);else process.stderr.write(`ERROR ${code}\n${message}\n${fix||""}\n`);return exitCode}
function writeHumanOrJson(options,payload,text){if(options.json)process.stdout.write(`${JSON.stringify(payload,null,2)}\n`);else process.stdout.write(text)}
const baseHelpFor=helpFor;
helpFor=function(command){
  if(/^doctor(\s+(quality|semantic|gitlab))?$/.test(String(command))){
    return`code-approval-gates doctor

Checks local/CI readiness and can create safe missing project files with --fix.

Usage:
  code-approval-gates doctor
  code-approval-gates doctor --fix
  code-approval-gates doctor --fix --yes
  code-approval-gates doctor --install-global
  code-approval-gates doctor quality --json --no-interactive
  code-approval-gates doctor semantic --ci --no-interactive
  code-approval-gates doctor semantic --fix-network --yes

Focus values:
  quality, semantic, gitlab

Fix behavior:
  --fix             Creates safe config/ignore/report files, installs semantic dependencies when missing, builds semantic dist when missing, and builds the quality sidecar image when Docker is available.
  --fix-network     Windows admin repair for Codex/API outbound access: creates outbound TCP 443 firewall rules for the Codex/Node runtime and checks api.openai.com.
  --yes             Pre-approve fix/install actions for scripts, CI, and other headless callers.
  --install-global  Explicitly runs npm install -g for this package.
`;
  }
  return baseHelpFor(command);
};
function helpPayloadFor(command,helpText=helpFor(command)){
  return{
    schemaVersion:1,
    command,
    help:helpText,
    commands:["run","quality","semantic","wizard","doctor","doctor quality","doctor semantic","doctor gitlab","baseline create","baseline check","report summary","report open","report path","config get","config set","config path","init","version","help"],
    scopes:["changed","full","paths"],
    wizard:{
      actions:["run","quality","semantic","baseline","report","config","doctor"],
      runGates:["both","quality","semantic"],
      scopeDefaults:{run:"changed",baseline:"full",others:"changed"},
      semanticPrompts:["objective","provider/model","ignore files","paths","threshold","output"]
    },
    headlessFlags:["--ci","--json","--no-interactive"],
    scoreAppliesTo:{changed:"changed-files",full:"entire-project",paths:"selected-paths"},
    errorShape:{schemaVersion:1,status:"ERROR",code:"ERROR_CODE",message:"Human-readable error message.",fix:"Suggested fix or null.",error:{code:"ERROR_CODE",message:"Human-readable error message.",fix:"Suggested fix or null."},exitCode:2}
  }
}
function helpFor(command){if(/^baseline\s+(create|check)$/.test(String(command)))command="baseline";if(/^report\s+(summary|open|path)$/.test(String(command)))command="report";if(/^config\s+(get|set|path)$/.test(String(command)))command="config";if(/^doctor\s+(quality|semantic|gitlab)$/.test(String(command)))command="doctor";const commonFlags=`\nCommon flags:\n  --cwd <dir>                       Project directory to analyze\n  --scope changed|full|paths       changed is the default\n  --path <path>                    Add a path for --scope paths\n  --exclude <glob>                 Exclude files/directories\n  --include <glob>                 Re-include a previously ignored path\n  --ignore-file <path>             Add another gitignore-style file\n  --threshold <number>             Default: 90\n  --format json|md|json,md         Default: json,md\n  --output <dir>                   Default: .quality/reports/latest\n  --ci                             Headless CI mode; implies --no-interactive\n  --json                           Machine-readable output only\n  --no-interactive                 Never prompt\n  --progress                       Print child gate progress to stderr in headless mode\n  --no-progress                    Suppress stderr progress in headless mode\n  --non-blocking                   Always exit 0 after writing reports\n\nScore scope:\n  Reports include scoreAppliesTo: changed-files, entire-project, or selected-paths.\n`;if(command==="run")return`code-approval-gates run\n\nRuns Quality Gate and Semantic Gate together.\n\nUsage:\n  code-approval-gates run\n  code-approval-gates run --scope changed\n  code-approval-gates run --gate quality --scope changed\n  code-approval-gates run --gate semantic --scope changed\n  code-approval-gates run --scope full\n  code-approval-gates run --scope paths --path apps/web --path packages/core\n  code-approval-gates run --ci --scope changed --format json,md --output code-approval-report --no-interactive\n${commonFlags}`;if(command==="quality")return`code-approval-gates quality\n\nRuns only the deterministic Quality Gate.\n\nUsage:\n  code-approval-gates quality --scope changed\n  code-approval-gates quality --scope full\n  code-approval-gates quality --scope paths --path docs\n  code-approval-gates quality --scope changed --json --no-interactive\n  code-approval-gates quality --ci --scope changed --format json,md --output code-approval-report --no-interactive\n${commonFlags}`;if(command==="semantic")return`code-approval-gates semantic\n\nRuns only the AI Semantic Gate.\n\nUsage:\n  code-approval-gates semantic --scope changed --objective-file objective.md\n  "Review architecture risks" | code-approval-gates semantic --scope full --objective-stdin --json --no-interactive\n  code-approval-gates semantic --ci --scope changed --objective-file objective.md --format json,md --output code-approval-report --no-interactive\n\nSemantic flags:\n  --objective <text>\n  --objective-file <path>\n  --objective-stdin\n  --provider <name>\n  --model <name>\n  --reasoning-effort <level>\n${commonFlags}`;if(command==="doctor")return`code-approval-gates doctor\n\nChecks local/CI readiness and can create safe missing project files with --fix.\n\nUsage:\n  code-approval-gates doctor\n  code-approval-gates doctor --fix\n  code-approval-gates doctor --fix --yes\n  code-approval-gates doctor --install-global\n  code-approval-gates doctor quality --json --no-interactive\n  code-approval-gates doctor semantic --ci --no-interactive\n\nFocus values:\n  quality, semantic, gitlab\n\nFix behavior:\n  --fix             Creates safe config/ignore/report files, installs semantic dependencies when missing, builds semantic dist when missing, and builds the quality sidecar image when Docker is available.\n  --yes             Pre-approve fix/install actions for scripts, CI, and other headless callers.
  --install-global  Explicitly runs npm install -g for this package.\n`;if(command==="wizard")return`code-approval-gates wizard\n\nStarts the interactive wizard/TUI.\n\nUsage:\n  code-approval-gates\n  code-approval-gates wizard\n\nThe wizard can choose action, gates (for run), scope, paths, excludes/includes, extra ignore files, Semantic provider/model, baseline outputs, and Doctor fix mode.\nIt only runs in an interactive TTY. Use explicit flags with --no-interactive for automation.\n`;if(command==="init")return`code-approval-gates init\n\nCreates default config and ignore files for a project.\n\nUsage:\n  code-approval-gates init\n\nCreates:\n  .code-approval-gates.json\n  .code-approval-gates.ignore\n  .quality-gate.ignore\n  .semantic-gate.ignore\n`;if(command==="baseline")return`code-approval-gates baseline\n\nCreates or checks a baseline of known findings.\n\nOutput contract:\n  In baseline create, --output is the baseline JSON file.\n  --report-output is the source scan report directory.\n\nUsage:\n  code-approval-gates baseline create --scope full --output .quality/baseline/baseline.json\n  code-approval-gates baseline create --from-report .quality/reports/full/summary.json --output .quality/baseline/baseline.json\n  code-approval-gates baseline create --refresh --report-output .quality/reports/baseline-source --output .quality/baseline/baseline.json\n  code-approval-gates baseline check --baseline .quality/baseline/baseline.json\n\nBaseline flags:\n  --scope changed|full|paths         Source scan scope; full is recommended for the first baseline\n  --path <path>                      Add a path for --scope paths\n  --exclude <glob>                   Exclude files/directories from the source scan\n  --include <glob>                   Re-include a previously ignored path\n  --ignore-file <path>               Add another gitignore-style file\n  --from-report <path>               Build baseline from an existing summary.json\n  --report-output <dir>              Output directory for the source scan used to build a baseline\n  --refresh                          Recreate the source scan before building baseline\n  --baseline <path>                  Baseline file for check/run commands\n  --no-semantic                      Build baseline without Semantic Gate findings\n  --no-quality                       Build baseline without Quality Gate findings\n\nAt least one gate must remain enabled. Do not combine --no-semantic and --no-quality.\n\nBaseline semantic source scan flags:\n  --objective <text>                Semantic objective for generated source scans\n  --objective-file <path>           Read semantic objective from file\n  --objective-stdin                 Read semantic objective from stdin before spawning the source scan\n  --provider <name>                 Semantic provider for generated source scans\n  --model <name>                    Semantic model for generated source scans\n  --reasoning-effort <level>        Semantic reasoning effort for generated source scans\n`;if(command==="report")return`code-approval-gates report\n\nReads generated reports.\n\nUsage:\n  code-approval-gates report summary --report-dir .quality/reports/latest\n  code-approval-gates report open --report-dir .quality/reports/latest\n  code-approval-gates report path --report-dir .quality/reports/latest\n\nFlags:\n  --report-dir <dir>                Report directory that contains summary.json\n  --output <dir>                    Backward-compatible alias for report directory\n`;if(command==="config")return`code-approval-gates config\n\nReads and writes .code-approval-gates.json. Dot paths are supported.\n\nUsage:\n  code-approval-gates config get\n  code-approval-gates config get semantic.provider\n  code-approval-gates config set threshold 90\n  code-approval-gates config set defaultScope full\n  code-approval-gates config set output .quality/reports/latest\n  code-approval-gates config set baseline.path .quality/baseline/baseline.json\n  code-approval-gates config set semantic.provider codex-cli\n  code-approval-gates config set semantic.model gpt-5.5\n  code-approval-gates config path\n\nValues are parsed as JSON-like scalars when possible: true, false, numbers, and strings.\nDo not store API keys in .code-approval-gates.json; use environment variables, a local secret store, or CI secrets.\nUse --json --no-interactive for automation.\n`;return`code-approval-gates ${VERSION}\n\nUsage:\n  code-approval-gates                 Open wizard when interactive\n  code-approval-gates wizard          Open wizard explicitly\n  code-approval-gates run             Run changed-scope Quality + Semantic gates\n  code-approval-gates quality         Run only deterministic quality gate\n  code-approval-gates semantic        Run only AI semantic gate\n  code-approval-gates baseline create Create baseline\n  code-approval-gates report          Show report helpers\n  code-approval-gates config          Read/write config\n  code-approval-gates doctor          Check environment\n  code-approval-gates init            Create config and ignore files\n  code-approval-gates version         Print version\n  code-approval-gates help <command>  Show command help\n\nExamples:\n  code-approval-gates run --scope changed\n  code-approval-gates run --gate quality --scope changed\n  code-approval-gates run --gate semantic --scope changed\n  code-approval-gates run --scope full --format json,md --output .quality/reports/full\n  code-approval-gates run --scope paths --path docs --path apps/web\n  code-approval-gates run --ci --scope changed --json --no-interactive\n\n${commonFlags}`}
if(require.main===module){main().then(code=>{process.exitCode=code}).catch(error=>{process.stderr.write(`code-approval-gates error: ${error.message||String(error)}\n`);process.exitCode=exitCodeForError(error)})}
module.exports={parseArgs,detectExecutionMode,resolveScopeFiles,matchesPattern,normalizePath,normalizedOptions,buildEquivalentCommand,buildBaselineSourceScanArgs,readObjective,helpFor,helpPayloadFor,runCodeApprovalGates:main};



















