/**
 * System-prompt transformation for client-mimic.
 *
 * A profile (or the global default) can decide how pi's built-in system prompt
 * is presented on each turn:
 *
 * - "off"     — leave pi's prompt untouched.
 * - "neutral" — apply the neutral "kun / π" identity rewrite. This keeps pi's
 *   generated tool list, guidelines, skills, context, date, and cwd intact and
 *   only rewrites the introductory identity + the CLI-docs help section. It is
 *   the behavior that previously lived in the standalone
 *   neutral-system-prompt.ts extension, folded in here so there is a single
 *   owner of the system prompt.
 * - "file"    — load prompt text from a file and combine it with pi's prompt
 *   ("replace" | "prepend" | "append"). Use this to present a client-specific
 *   system prompt (e.g. a Codex or Claude Code preamble) when your gateway
 *   inspects the prompt for a matching client identity.
 *
 * Precedence: when a profile is active and its systemPrompt.mode is not
 * "inherit", the profile wins. Otherwise the global MimicConfig.systemPrompt
 * applies (with "inherit" treated as "off").
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { agentDir, type MimicConfig, type MimicProfile, type SystemPromptSpec } from "./config.ts";

export interface PromptResolution {
	prompt: string;
	/** Human-readable note describing what was applied, for logging/UI. */
	note?: string;
	/** Non-fatal warning (e.g. a missing file), for UI surfacing. */
	warning?: string;
}

/** The neutral "kun / π" identity used by the neutral rewrite. */
const NEUTRAL_INTRO =
	"You are an expert software-development assistant named kun and code-named “π”. Help users inspect files, run commands, modify code, and create files.";

/**
 * Rewrite pi's built-in system prompt to the neutral "kun / π" identity while
 * preserving all runtime-generated sections. Mirrors the standalone
 * neutral-system-prompt.ts extension.
 */
export function neutralRewrite(prompt: string): string {
	let out = prompt;

	// Replace whatever introductory wording precedes the generated tool list.
	out = out.replace(/^[\s\S]*?(?=\n\nAvailable tools:)/, NEUTRAL_INTRO);

	// Rephrase the pi-specific docs/help section to a neutral CLI reference.
	out = out.replace(
		/\n\nπ documentation \(read only[^]*?\n- Main documentation: ([^\n]+)\n- Additional docs: ([^\n]+)\n- Examples: ([^\n]+) \(extensions, custom tools, SDK\)[^]*?\n- Always read pi \.md files completely[^\n]*/,
		(_match, readmePath: string, docsPath: string, examplesPath: string) =>
			`\n\nCoding-agent CLI reference material (consult it only for questions about the CLI, its SDK, extensions, themes, skills, or terminal interface):
- Overview: ${readmePath}
- Reference guides: ${docsPath}
- Working examples: ${examplesPath} (extensions, tools, and SDK integrations)
- Resolve a docs/... path against the reference-guides directory, and an examples/... path against the examples directory; do not resolve either relative to the current project.
- Relevant guides include: extensions.md, themes.md, skills.md, prompt-templates.md, tui.md, keybindings.md, sdk.md, custom-provider.md, models.md, and packages.md.
- Before changing CLI-related code, read the applicable guide and its linked Markdown references in full.`,
	);

	return out;
}

/** Resolve a possibly-relative prompt file path against the agent dir. */
export function resolvePromptPath(file: string): string {
	return isAbsolute(file) ? file : join(agentDir(), file);
}

/**
 * Pick the effective SystemPromptSpec: the active profile's spec wins unless it
 * is "inherit" (or absent), in which case the global default applies. When no
 * profile is active, the global default applies. A global "inherit" is treated
 * as "off".
 */
export function effectiveSpec(cfg: MimicConfig, profile: MimicProfile | null): SystemPromptSpec {
	if (profile && profile.systemPrompt.mode !== "inherit") {
		return profile.systemPrompt;
	}
	const global = cfg.systemPrompt;
	return global.mode === "inherit" ? { mode: "off" } : global;
}

/**
 * Apply the effective system-prompt spec to pi's built-in prompt.
 * Returns the (possibly unchanged) prompt plus notes/warnings.
 */
export function applySystemPrompt(
	basePrompt: string,
	spec: SystemPromptSpec,
): PromptResolution {
	switch (spec.mode) {
		case "off":
		case "inherit":
			return { prompt: basePrompt };

		case "neutral":
			return { prompt: neutralRewrite(basePrompt), note: "neutral kun/π identity" };

		case "file": {
			if (!spec.file) {
				return { prompt: basePrompt, warning: "systemPrompt.mode=file but no file configured; left prompt unchanged" };
			}
			const path = resolvePromptPath(spec.file);
			if (!existsSync(path)) {
				return { prompt: basePrompt, warning: `system prompt file not found: ${path}; left prompt unchanged` };
			}
			let text: string;
			try {
				text = readFileSync(path, "utf8");
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return { prompt: basePrompt, warning: `failed to read system prompt file ${path}: ${msg}; left prompt unchanged` };
			}
			const apply = spec.apply ?? "replace";
			if (apply === "prepend") {
				return { prompt: `${text.trimEnd()}\n\n${basePrompt}`, note: `file prepend (${path})` };
			}
			if (apply === "append") {
				return { prompt: `${basePrompt}\n\n${text.trimStart()}`, note: `file append (${path})` };
			}
			return { prompt: text, note: `file replace (${path})` };
		}

		default:
			return { prompt: basePrompt };
	}
}
