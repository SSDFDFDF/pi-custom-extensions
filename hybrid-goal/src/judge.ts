/**
 * Independent completion judge (MiMo-style cold verifier).
 *
 * Does not participate in the working agent's tool loop. Reads a transcript
 * slice + objective/summary and returns a structured verdict.
 */

import { complete } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	serializeConversation,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { HybridGoalConfig } from "./config.js";
import { parseModelRef } from "./config.js";

export interface JudgeVerdict {
	ok: boolean;
	impossible?: boolean;
	reason: string;
	/** Transport/parse failure; policy decides whether completion proceeds. */
	error?: boolean;
	attempt?: number;
	model?: string;
}

export interface JudgeInput {
	condition: string;
	summary?: string;
	config: HybridGoalConfig;
	ctx: ExtensionContext;
	signal?: AbortSignal;
}

const JUDGE_SYSTEM = `You are evaluating a stop-condition / completion claim for a coding agent goal.
You are an independent judge. You do not do the work. Stay cold relative to the working agent's optimism.

Read the conversation transcript carefully (including tool outputs), then judge whether the user-provided condition is satisfied.

Respond with ONLY a JSON object, no markdown fences, one of:
- {"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}
- {"ok": false, "reason": "<quote what is missing or what blocks the condition>"}
- {"ok": false, "impossible": true, "reason": "<explain why the condition can never be satisfied in this session>"}

Rules:
- If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.
- Only use impossible:true when the condition is genuinely unachievable (self-contradictory, missing capability/resource, or the assistant exhausted reasonable approaches AND you independently confirm unachievability). The assistant claiming impossibility is evidence, not proof.
- Do not mark impossible merely because progress is slow or incomplete.
- Prefer false negatives (not ok) over false positives when evidence is weak.`;

function judgeUser(condition: string, summary: string | undefined) {
	const claim = summary?.trim()
		? `\nWorking agent completion claim / summary:\n${summary.trim()}\n`
		: "";
	return `Based on the conversation transcript above, has the following stopping condition / goal been satisfied? Answer from transcript evidence only.
${claim}
Condition / goal objective:
${condition}`;
}

export function parseJudgeVerdictText(text: string): JudgeVerdict | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;

	const candidates: string[] = [trimmed];
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
	if (fenced?.[1]) candidates.unshift(fenced[1].trim());
	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
	}

	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as {
				ok?: unknown;
				impossible?: unknown;
				reason?: unknown;
			};
			if (typeof parsed.ok !== "boolean") continue;
			const reason =
				typeof parsed.reason === "string" && parsed.reason.trim()
					? parsed.reason.trim()
					: parsed.ok
						? "condition satisfied"
						: "condition not satisfied";
			return {
				ok: parsed.ok,
				impossible: parsed.impossible === true,
				reason: reason.slice(0, 4_000),
			};
		} catch {
			// try next candidate
		}
	}
	return undefined;
}

export function buildTranscriptText(
	ctx: ExtensionContext,
	maxChars: number,
): { text: string; messageCount: number } {
	const context = ctx.sessionManager.buildSessionContext?.() ?? {
		messages: [],
	};
	const messages = context.messages ?? [];
	const llmMessages = convertToLlm(messages as never[]);
	let text = serializeConversation(llmMessages);
	if (text.length > maxChars) {
		const head = Math.floor(maxChars * 0.35);
		const tail = maxChars - head - 80;
		text = `${text.slice(0, head)}\n\n…[transcript truncated for judge budget]…\n\n${text.slice(-tail)}`;
	}
	return { text, messageCount: messages.length };
}

export async function evaluateGoalJudge(input: JudgeInput): Promise<JudgeVerdict> {
	const { condition, summary, config, ctx, signal } = input;
	if (!config.judgeEnabled) {
		return { ok: true, reason: "judge disabled" };
	}

	const model = resolveJudgeModel(ctx, config);
	if (!model) {
		return {
			ok: false,
			error: true,
			reason: "judge model unavailable (no current model and no valid judgeModel config)",
		};
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		return {
			ok: false,
			error: true,
			reason: auth.ok
				? `no API key for judge model ${model.provider}/${model.id}`
				: `judge auth failed: ${auth.error}`,
			model: `${model.provider}/${model.id}`,
		};
	}

	const { text: transcript, messageCount } = buildTranscriptText(
		ctx,
		config.judgeTranscriptChars,
	);
	if (!transcript.trim()) {
		return {
			ok: false,
			reason: "insufficient evidence in transcript (empty conversation)",
			model: `${model.provider}/${model.id}`,
		};
	}

	const userContent = `<conversation messages="${messageCount}">\n${transcript}\n</conversation>\n\n${judgeUser(condition, summary)}`;

	try {
		const options: Record<string, unknown> = {
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			signal,
			maxTokens: 1_024,
		};
		// Prefer temperature 0 when supported (MiMo cold judge).
		if (model.supportsTemperature !== false) {
			options.temperature = 0;
		}

		const response = await complete(
			model,
			{
				systemPrompt: JUDGE_SYSTEM,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: userContent }],
						timestamp: Date.now(),
					},
				],
			},
			options as never,
		);

		if (response.stopReason === "aborted") {
			return {
				ok: false,
				error: true,
				reason: "judge aborted",
				model: `${model.provider}/${model.id}`,
			};
		}
		if (response.stopReason === "error") {
			return {
				ok: false,
				error: true,
				reason: response.errorMessage ?? "judge provider error",
				model: `${model.provider}/${model.id}`,
			};
		}

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		const parsed = parseJudgeVerdictText(text);
		if (!parsed) {
			return {
				ok: false,
				error: true,
				reason: `judge returned unparseable verdict: ${text.slice(0, 240)}`,
				model: `${model.provider}/${model.id}`,
			};
		}
		return { ...parsed, model: `${model.provider}/${model.id}` };
	} catch (error) {
		return {
			ok: false,
			error: true,
			reason: error instanceof Error ? error.message : String(error),
			model: `${model.provider}/${model.id}`,
		};
	}
}

function resolveJudgeModel(ctx: ExtensionContext, config: HybridGoalConfig) {
	const configured = config.judgeModel?.trim() ?? "";
	const ref = parseModelRef(configured);
	if (ref) {
		const found = ctx.modelRegistry.find(ref.provider, ref.modelId);
		if (found) return found;
		// Explicit judgeModel was configured but could not be resolved. Do not
		// silently fall back to the working model — that weakens cold verification.
		try {
			ctx.ui?.notify?.(
				`Judge model ${configured} not found; completion remains closed until judgeModel is fixed or cleared.`,
				"warning",
			);
		} catch {
			/* non-UI contexts */
		}
		return undefined;
	}
	// Empty/invalid judgeModel → use the current session model.
	return ctx.model ?? undefined;
}

export function formatVerdictForAgent(verdict: JudgeVerdict): string {
	if (verdict.impossible) {
		return `Judge marked goal impossible: ${verdict.reason}`;
	}
	if (verdict.ok) {
		return `Judge accepted completion: ${verdict.reason}`;
	}
	return `Judge rejected completion: ${verdict.reason}`;
}

export function shouldAllowCompletionOnJudgeError(
	verdict: JudgeVerdict,
	policy: HybridGoalConfig["judgeFailPolicy"],
): boolean {
	if (!verdict.error) return verdict.ok;
	return policy === "fail-open";
}
