import type { ExecutionProfile } from "./capability-profile.js";
import type {
  NestedSessionEvent,
  NestedSessionIdentity,
  NestedSessionTranscriptActivity,
} from "./nested-session.js";

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
  readonly onActivity?: (activity: NestedSessionTranscriptActivity) => void;
}

export interface GrillingSeatLaunchRequest extends PanelSeatLaunchBase {
  readonly kind: "grilling";
  readonly context: Readonly<GrillingRoundContext>;
}

export interface ReviewRoundContext {
  readonly round: number;
  readonly headSha: string;
  readonly brief: string;
}

export interface ReviewSeatLaunchRequest extends PanelSeatLaunchBase {
  readonly kind: "review";
  readonly context: Readonly<ReviewRoundContext>;
}

export type PanelSeatLaunchRequest = GrillingSeatLaunchRequest | ReviewSeatLaunchRequest;
export type PanelSeatLauncher = (request: PanelSeatLaunchRequest) => Promise<unknown>;
export type PanelActivityListener = (event: NestedSessionEvent) => void;

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
    if (request.kind === "review") {
      const report = result.stdout.trim();
      if (!report) throw new Error("Reviewer returned an empty report");
      return report;
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

export interface AttributedReviewReport extends PanelSeatAttribution {
  readonly round: number;
  readonly headSha: string;
  readonly markdown: string;
}

export interface ReviewPanelResult {
  readonly reports: readonly AttributedReviewReport[];
  readonly failures: readonly PanelSeatFailure[];
}

function panelFailureDiagnostic(failure: PanelSeatFailure): string {
  const seat = failure.attribution;
  return `${seat.seat} (${seat.harness} ${seat.providerSlug}/${seat.modelSlug} ${seat.reasoningLevel}): ${failure.error}`;
}

export class PanelRuntimeError extends Error {
  readonly failures: readonly PanelSeatFailure[];

  constructor(
    message: string,
    failures: readonly PanelSeatFailure[],
  ) {
    const diagnostic = failures.length === 0
      ? message
      : `${message}\n${failures.map(panelFailureDiagnostic).join("\n")}`;
    super(diagnostic);
    this.name = "PanelRuntimeError";
    this.failures = immutableClone(failures);
  }
}

function nestedPanelIdentity(seat: PanelSeatAttribution, headSha?: string): NestedSessionIdentity {
  return {
    id: seat.seat,
    source: "panel",
    label: `${seat.seat} · ${seat.modelSlug}`,
    harness: seat.harness,
    provider: seat.providerSlug,
    model: seat.modelSlug,
    reasoning: seat.reasoningLevel,
    ...(headSha === undefined ? {} : { headSha }),
  };
}

function boundedPanelPrompt(prompt: string): string {
  return prompt.length > 8_000 ? `${prompt.slice(0, 8_000)}… [truncated]` : prompt;
}

function panelSeatRequestActivity(
  identity: NestedSessionIdentity,
  listener: PanelActivityListener | undefined,
): ((activity: NestedSessionTranscriptActivity) => void) | undefined {
  if (!listener) return undefined;
  return (activity) => listener({ ...identity, type: "activity", activity });
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
  onActivity?: PanelActivityListener,
): Promise<GrillingPanelResult> {
  const context = deepFreeze(withoutRecommendations(structuredClone(request.context)));
  const questionNumbers = validateGrillingContext(context);
  const prompt = grillingPrompt(context);
  const tools = Object.freeze(["read", "grep", "find", "ls"]);
  const identities = seats.map((seat) => nestedPanelIdentity(seat));
  const settled = await Promise.allSettled(seats.map((seat, index) => {
    const identity = identities[index]!;
    onActivity?.({ ...identity, type: "started", initialPrompt: boundedPanelPrompt(prompt) });
    return launcher({
      kind: "grilling",
      attribution: seat,
      context,
      prompt,
      tools,
      onActivity: panelSeatRequestActivity(identity, onActivity),
    });
  }));
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
        onActivity?.({ ...identities[index]!, type: "settled", status: "completed" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(Object.freeze({ attribution: seat, error: message }));
        onActivity?.({ ...identities[index]!, type: "settled", status: "failed", message });
      }
    } else {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push(Object.freeze({ attribution: seat, error: message }));
      onActivity?.({ ...identities[index]!, type: "settled", status: "failed", message });
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
  if (!nonEmptyString(context.brief)) throw new Error("Review context requires a review brief");
}

function reviewPrompt(context: ReviewRoundContext): string {
  return [
    "Independently review this exact head for correctness, specification compliance, and repository standards.",
    "Round one must be exhaustive. A later round must verify prior root causes, fixes, and directly affected invariant paths.",
    "Write a concise Markdown review for another agent to interpret and publish as a GitHub pull-request review.",
    "For each substantiated pull-request-introduced finding, give a [P0]-[P3] title, the exact changed path and line or range, the violated requirement, and concrete evidence. State 'No actionable findings.' when appropriate.",
    "Do not decide scope or prescribe workflow actions. Do not ask a human, progress queues, dispatch stages, launch subagents, merge, or mutate tracker state.",
    JSON.stringify(context),
  ].join("\n\n");
}

function reviewMarkdown(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Reviewer report must contain Markdown text");
  }
  return value.trim();
}

export async function runReviewPanel(
  request: ReviewPanelRequest,
  launcher: PanelSeatLauncher,
  seats: readonly PanelSeatAttribution[],
  onActivity?: PanelActivityListener,
): Promise<ReviewPanelResult> {
  const context = immutableClone(request.context);
  validateReviewContext(context);
  const prompt = reviewPrompt(context);
  const tools = Object.freeze(["read", "grep", "find", "ls"]);
  const identities = seats.map((seat) => nestedPanelIdentity(seat, context.headSha));
  const settled = await Promise.allSettled(seats.map((seat, index) => {
    const identity = identities[index]!;
    onActivity?.({ ...identity, type: "started", initialPrompt: boundedPanelPrompt(prompt) });
    return launcher({
      kind: "review",
      attribution: seat,
      context,
      prompt,
      tools,
      onActivity: panelSeatRequestActivity(identity, onActivity),
    });
  }));
  const reports: AttributedReviewReport[] = [];
  const failures: PanelSeatFailure[] = [];
  settled.forEach((result, index) => {
    const seat = seats[index]!;
    if (result.status === "rejected") {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push(Object.freeze({ attribution: seat, error: message }));
      onActivity?.({ ...identities[index]!, type: "settled", status: "failed", message });
      return;
    }
    try {
      reports.push(deepFreeze({
        round: context.round,
        headSha: context.headSha,
        ...seat,
        markdown: reviewMarkdown(result.value),
      }));
      onActivity?.({ ...identities[index]!, type: "settled", status: "completed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(Object.freeze({ attribution: seat, error: message }));
      onActivity?.({ ...identities[index]!, type: "settled", status: "failed", message });
    }
  });
  return deepFreeze({ reports, failures });
}
