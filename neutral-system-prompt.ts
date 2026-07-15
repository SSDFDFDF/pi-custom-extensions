import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Rephrase the built-in system prompt as neutral coding-agent instructions.
 *
 * The runtime still produces the dynamic portions (active tools, their
 * descriptions, guidelines, context files, skills, date, and working
 * directory). This extension only replaces the introductory and local-help
 * sections, so it stays useful when the installed CLI gains tools or skills.
 */
export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    let prompt = event.systemPrompt;

    // Replace whatever introductory wording precedes the generated tool list.
    prompt = prompt.replace(
      /^[\s\S]*?(?=\n\nAvailable tools:)/,
      "You are an expert software-development assistant named kun and code-named “π”. Help users inspect files, run commands, modify code, and create files.",
    );

    prompt = prompt.replace(
      /\n\nπ documentation \(read only[^]*?\n- Main documentation: ([^\n]+)\n- Additional docs: ([^\n]+)\n- Examples: ([^\n]+) \(extensions, custom tools, SDK\)[^]*?\n- Always read pi \.md files completely[^\n]*/,
      (_match, readmePath: string, docsPath: string, examplesPath: string) => `\n\nCoding-agent CLI reference material (consult it only for questions about the CLI, its SDK, extensions, themes, skills, or terminal interface):
- Overview: ${readmePath}
- Reference guides: ${docsPath}
- Working examples: ${examplesPath} (extensions, tools, and SDK integrations)
- Resolve a docs/... path against the reference-guides directory, and an examples/... path against the examples directory; do not resolve either relative to the current project.
- Relevant guides include: extensions.md, themes.md, skills.md, prompt-templates.md, tui.md, keybindings.md, sdk.md, custom-provider.md, models.md, and packages.md.
- Before changing CLI-related code, read the applicable guide and its linked Markdown references in full.`,
    );

    return prompt === event.systemPrompt ? undefined : { systemPrompt: prompt };
  });
}
