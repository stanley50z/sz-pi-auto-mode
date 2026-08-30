import type { ExecutionProfile } from "./capability-profile.js";

export interface PanelSeatAttribution {
  readonly seat: `seat-${number}`;
  readonly harness: ExecutionProfile["harness"];
  readonly providerSlug: string;
  readonly modelSlug: string;
  readonly reasoningLevel: ExecutionProfile["reasoning"];
}

export interface GrillingQuestion {
  readonly number: number;
  readonly question: string;
  readonly options?: readonly string[];
  readonly recommendation?: string;
}

export interface GrillingRound {
  readonly number: number;
  readonly questions: readonly GrillingQuestion[];
}

export interface PriorFinalAnswers {
  readonly roundNumber: number;
  readonly answers: readonly {
    readonly questionNumber: number;
    readonly answer: string;
  }[];
}

export interface GrillingRoundContext {
  readonly userPrompts: readonly string[];
  readonly priorRounds: readonly GrillingRound[];
  readonly priorFinalAnswers: readonly PriorFinalAnswers[];
  readonly round: GrillingRound;
}

export interface GrillingPanelRequest {
  readonly context: GrillingRoundContext;
}

interface PanelSeatLaunchBase {
  readonly attribution: PanelSeatAttribution;
  readonly prompt: string;
  readonly tools: readonly string[];
}

export interface GrillingSeatLaunchRequest extends PanelSeatLaunchBase {
  readonly kind: "grilling";
  readonly context: Readonly<GrillingRoundContext>;
}

export interface ReviewRoundContext {
  readonly round: number;
  readonly headSha: string;
  readonly pullRequestBody: string;
  readonly linkedIssueOrSpecification: string;
  readonly repositoryGuidance: readonly string[];
  readonly mergeBaseDiff: string;
  readonly commits: readonly string[];
  readonly validationEvidence: readonly string[];
  readonly priorFindings?: readonly string[];
  readonly reviewSessionDispositions?: readonly string[];
  readonly fixDiff?: string;
}

export interface ReviewSeatLaunchRequest extends PanelSeatLaunchBase {
  readonly kind: "review";
  readonly context: Readonly<ReviewRoundContext>;
}

export type PanelSeatLaunchRequest = GrillingSeatLaunchRequest | ReviewSeatLaunchRequest;
export type PanelSeatLauncher = (request: PanelSeatLaunchRequest) => Promise<unknown>;

export interface PanelProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProductionPanelProcessLauncher {
  launch(request: PanelSeatLaunchRequest): Promise<PanelProcessResult>;
}

export function createProductionPanelSeatLauncher(
  processLauncher?: ProductionPanelProcessLauncher,
): PanelSeatLauncher {
  if (!processLauncher) throw new Error("The production Panel process launcher is unavailable");
  return async (request) => {
    const result = await processLauncher.launch(request);
    if (result.exitCode !== 0 || result.signal !== null) {
      const termination = result.signal === null
        ? `exited with code ${String(result.exitCode)}`
        : `terminated by ${result.signal}`;
      const detail = result.stderr.trim();
      throw new Error(`Panel seat process ${termination}${detail ? `: ${detail}` : ""}`);
    }
    try {
      const output: unknown = JSON.parse(result.stdout.trim());
      if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("expected an object");
      return output;
    } catch (error) {
      throw new Error("Panel seat process returned invalid structured output", { cause: error });
    }
  };
}

export interface PanelQuestionAnswer {
  readonly questionNumber: number;
  readonly proposedAnswer: string;
  readonly rationale: string;
  readonly materialTradeoffs: string;
  readonly assumptionsOrUncertainties: string;
  readonly sources: readonly string[];
}

export interface AttributedPanelAnswer {
  readonly attribution: PanelSeatAttribution;
  readonly answers: readonly PanelQuestionAnswer[];
}

export interface PanelSeatFailure {
  readonly attribution: PanelSeatAttribution;
  readonly error: string;
}

export interface GrillingPanelResult {
  readonly answers: readonly AttributedPanelAnswer[];
  readonly failures: readonly PanelSeatFailure[];
}

export interface ReviewPanelRequest {
  readonly context: ReviewRoundContext;
}

export interface ReviewFinding {
  readonly rootCause: string;
  readonly violatedRequirement: string;
  readonly evidence: string;
}

export interface AttributedReviewReport extends PanelSeatAttribution {
  readonly round: number;
  readonly headSha: string;
  readonly outcome: "findings" | "no-actionable-findings";
  readonly findings: readonly ReviewFinding[];
}

export interface ReviewPanelResult {
  readonly reports: readonly AttributedReviewReport[];
}

function panelFailureDiagnostic(failure: PanelSeatFailure): string {
  const seat = failure.attribution;
  return `${seat.seat} (${seat.harness} ${seat.providerSlug}/${seat.modelSlug} ${seat.reasoningLevel}): ${failure.error}`;
}

export class PanelRuntimeError extends Error {
  readonly failures: readonly PanelSeatFailure[];
  readonly successfulResults: readonly unknown[];

  constructor(
    message: string,
    failures: readonly PanelSeatFailure[],
    successfulResults: readonly unknown[] = [],
  ) {
    const diagnostic = failures.length === 0
      ? message
      : `${message}\n${failures.map(panelFailureDiagnostic).join("\n")}`;
    super(diagnostic);
    this.name = "PanelRuntimeError";
    this.failures = immutableClone(failures);
    this.successfulResults = immutableClone(successfulResults);
  }
}

export function createPanelSeats(
  executions: readonly ExecutionProfile[],
): readonly PanelSeatAttribution[] {
  if (executions.length === 0) throw new Error("The panel requires at least one configured seat");
  return Object.freeze(executions.map((profile, index) => Object.freeze({
    seat: `seat-${index + 1}` as const,
    harness: profile.harness,
    providerSlug: profile.provider ?? "anthropic",
    modelSlug: profile.model,
    reasoningLevel: profile.reasoning,
  })));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function withoutRecommendations<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutRecommendations) as T;
  if (!value || typeof value !== "object") return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "recommendation" || key === "nativeRecommendation") continue;
    sanitized[key] = withoutRecommendations(nested);
  }
  return sanitized as T;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateRound(round: GrillingRound): readonly number[] {
  if (!Number.isInteger(round.number) || round.number < 1) {
    throw new Error("Grilling Round number must be a positive integer");
  }
  if (round.questions.length === 0) throw new Error("A Grilling Round must contain at least one question");
  const numbers = round.questions.map((question) => question.number);
  if (numbers.some((number) => !Number.isInteger(number) || number < 1) || new Set(numbers).size !== numbers.length) {
    throw new Error("Grilling Round question numbers must be unique positive integers");
  }
  for (const question of round.questions) {
    if (!nonEmptyString(question.question)) throw new Error("Every Grilling Round question must contain text");
    if (question.options?.some((option) => !nonEmptyString(option))) {
      throw new Error("Grilling Round options must contain text");
    }
  }
  return numbers;
}

function validateGrillingContext(context: GrillingRoundContext): readonly number[] {
  if (context.userPrompts.length === 0 || context.userPrompts.some((prompt) => !nonEmptyString(prompt))) {
    throw new Error("Round Context requires every user prompt");
  }
  const questionNumbers = validateRound(context.round);
  const priorRoundNumbers = context.priorRounds.map((round) => round.number);
  if (
    new Set(priorRoundNumbers).size !== priorRoundNumbers.length
    || priorRoundNumbers.some((number) => number >= context.round.number)
  ) throw new Error("Prior Grilling Rounds must be unique and precede the current round");
  for (const round of context.priorRounds) validateRound(round);
  const answerRounds = context.priorFinalAnswers.map((answers) => answers.roundNumber);
  if (
    answerRounds.length !== priorRoundNumbers.length
    || new Set(answerRounds).size !== answerRounds.length
    || priorRoundNumbers.some((number) => !answerRounds.includes(number))
  ) throw new Error("Round Context requires complete final answers for every prior round");
  for (const round of context.priorRounds) {
    const final = context.priorFinalAnswers.find((answers) => answers.roundNumber === round.number)!;
    const expected = round.questions.map((question) => question.number);
    const received = final.answers.map((answer) => answer.questionNumber);
    if (
      received.length !== expected.length
      || new Set(received).size !== received.length
      || expected.some((number) => !received.includes(number))
      || final.answers.some((answer) => !nonEmptyString(answer.answer))
    ) throw new Error("Round Context requires complete final answers for every prior round");
  }
  return questionNumbers;
}

function validatePanelAnswer(value: unknown, questionNumbers: readonly number[]): readonly PanelQuestionAnswer[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { answers?: unknown }).answers)) {
    throw new Error("Panel answer must be structured as an answers array");
  }
  const answers = (value as { answers: unknown[] }).answers;
  const receivedNumbers = answers.map((answer) => (
    answer && typeof answer === "object" ? (answer as { questionNumber?: unknown }).questionNumber : undefined
  ));
  if (
    answers.length !== questionNumbers.length
    || new Set(receivedNumbers).size !== receivedNumbers.length
    || questionNumbers.some((number) => !receivedNumbers.includes(number))
  ) {
    throw new Error("Panel answer must cover every question exactly once");
  }
  for (const answer of answers) {
    if (!answer || typeof answer !== "object") throw new Error("Every question answer must be structured");
    const candidate = answer as Record<string, unknown>;
    if (
      !Number.isInteger(candidate.questionNumber)
      || !nonEmptyString(candidate.proposedAnswer)
      || !nonEmptyString(candidate.rationale)
      || !nonEmptyString(candidate.materialTradeoffs)
      || !nonEmptyString(candidate.assumptionsOrUncertainties)
      || !Array.isArray(candidate.sources)
      || candidate.sources.some((source) => !nonEmptyString(source))
    ) {
      throw new Error("Every question answer requires an answer, rationale, trade-offs, uncertainty, and sources");
    }
  }
  return immutableClone(answers as unknown as PanelQuestionAnswer[]);
}

function grillingPrompt(context: GrillingRoundContext): string {
  return [
    "Act as an independent adviser. Answer every question in the numbered round.",
    "Preserve the supplied questions and options. Distinguish facts from judgment and cite sources for consequential factual claims.",
    "Do not ask a human, progress queues, dispatch stages, launch subagents, merge, or mutate tracker state.",
    "Return JSON with an answers array. Each answer must contain questionNumber, proposedAnswer, rationale, materialTradeoffs, assumptionsOrUncertainties, and sources.",
    JSON.stringify(context),
  ].join("\n\n");
}

export async function runGrillingPanel(
  request: GrillingPanelRequest,
  launcher: PanelSeatLauncher,
  seats: readonly PanelSeatAttribution[],
): Promise<GrillingPanelResult> {
  const context = deepFreeze(withoutRecommendations(structuredClone(request.context)));
  const questionNumbers = validateGrillingContext(context);
  const prompt = grillingPrompt(context);
  const tools = Object.freeze(["read", "grep", "find", "ls"]);
  const settled = await Promise.allSettled(seats.map((seat) => launcher({
    kind: "grilling",
    attribution: seat,
    context,
    prompt,
    tools,
  })));
  const answers: AttributedPanelAnswer[] = [];
  const failures: PanelSeatFailure[] = [];
  settled.forEach((result, index) => {
    const seat = seats[index]!;
    if (result.status === "fulfilled") {
      try {
        answers.push(Object.freeze({
          attribution: seat,
          answers: validatePanelAnswer(result.value, questionNumbers),
        }));
      } catch (error) {
        failures.push(Object.freeze({
          attribution: seat,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    } else {
      failures.push(Object.freeze({
        attribution: seat,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      }));
    }
  });
  if (answers.length === 0) {
    throw new PanelRuntimeError("Grilling round failed because every configured seat failed", failures);
  }
  return deepFreeze({ answers, failures });
}

function validateReviewContext(context: ReviewRoundContext): void {
  if (!Number.isInteger(context.round) || context.round < 1) {
    throw new Error("Review round number must be a positive integer");
  }
  if (!/^[a-f0-9]{7,64}$/i.test(context.headSha)) throw new Error("Review context requires an exact head SHA");
  const strings = [
    context.pullRequestBody,
    context.linkedIssueOrSpecification,
    context.mergeBaseDiff,
  ];
  if (strings.some((value) => !nonEmptyString(value))) {
    throw new Error("Review context is missing pull-request, specification, or diff content");
  }
  const lists = [context.repositoryGuidance, context.commits, context.validationEvidence];
  if (lists.some((list) => list.length === 0 || list.some((value) => !nonEmptyString(value)))) {
    throw new Error("Review context requires guidance, commits, and validation evidence");
  }
  if (context.round > 1 && (
    !context.priorFindings
    || !context.reviewSessionDispositions
    || !nonEmptyString(context.fixDiff)
  )) {
    throw new Error("Later review rounds require prior findings, Review Session dispositions, and the fix diff");
  }
}

function reviewPrompt(context: ReviewRoundContext): string {
  return [
    "Independently review this exact head for correctness, specification compliance, and repository standards.",
    "Round one must be exhaustive. A later round must verify prior root causes, fixes, and directly affected invariant paths.",
    "Report only substantiated root causes. For each finding, identify the violated requirement, rule, or invariant and concrete evidence. Do not decide scope or prescribe workflow actions.",
    "Do not ask a human, progress queues, dispatch stages, launch subagents, merge, or mutate tracker state.",
    "Return JSON with outcome set to findings or no-actionable-findings and a findings array. Each finding requires rootCause, violatedRequirement, and evidence.",
    JSON.stringify(context),
  ].join("\n\n");
}

function validateReviewReport(value: unknown): {
  readonly outcome: AttributedReviewReport["outcome"];
  readonly findings: readonly ReviewFinding[];
} {
  if (!value || typeof value !== "object") throw new Error("Reviewer report must be structured JSON");
  const candidate = value as { outcome?: unknown; findings?: unknown };
  if (
    candidate.outcome !== "findings"
    && candidate.outcome !== "no-actionable-findings"
  ) throw new Error("Reviewer report requires a valid outcome");
  if (!Array.isArray(candidate.findings)) throw new Error("Reviewer report requires a findings array");
  if (
    (candidate.outcome === "findings" && candidate.findings.length === 0)
    || (candidate.outcome === "no-actionable-findings" && candidate.findings.length !== 0)
  ) throw new Error("Reviewer report outcome must agree with its findings");
  for (const finding of candidate.findings) {
    if (!finding || typeof finding !== "object") throw new Error("Every review finding must be structured");
    const fields = finding as Record<string, unknown>;
    if (
      !nonEmptyString(fields.rootCause)
      || !nonEmptyString(fields.violatedRequirement)
      || !nonEmptyString(fields.evidence)
    ) throw new Error("Every review finding requires a root cause, violated requirement, and evidence");
  }
  return immutableClone({
    outcome: candidate.outcome,
    findings: candidate.findings as ReviewFinding[],
  });
}

export async function runReviewPanel(
  request: ReviewPanelRequest,
  launcher: PanelSeatLauncher,
  seats: readonly PanelSeatAttribution[],
): Promise<ReviewPanelResult> {
  const context = immutableClone(request.context);
  validateReviewContext(context);
  const prompt = reviewPrompt(context);
  const tools = Object.freeze(["read", "grep", "find", "ls"]);
  const settled = await Promise.allSettled(seats.map((seat) => launcher({
    kind: "review",
    attribution: seat,
    context,
    prompt,
    tools,
  })));
  const reports: AttributedReviewReport[] = [];
  const failures: PanelSeatFailure[] = [];
  settled.forEach((result, index) => {
    const seat = seats[index]!;
    if (result.status === "rejected") {
      failures.push(Object.freeze({
        attribution: seat,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      }));
      return;
    }
    try {
      const report = validateReviewReport(result.value);
      reports.push(deepFreeze({
        round: context.round,
        headSha: context.headSha,
        ...seat,
        outcome: report.outcome,
        findings: report.findings,
      }));
    } catch (error) {
      failures.push(Object.freeze({
        attribution: seat,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  });
  if (reports.length !== seats.length) {
    throw new PanelRuntimeError(
      "Review round requires usable reports from every configured seat",
      failures,
      reports,
    );
  }
  return deepFreeze({ reports });
}
