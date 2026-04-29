/**
 * Eject: bootstrap a local pi agent
 *
 * Run `/eject` to create `.pi/SYSTEM.md` with a purpose-built system prompt.
 *
 * Usage:
 *   /eject               → prompts for a description (interactive only)
 *   /eject <description> → uses description to generate a system prompt via LLM
 */

import { complete, type Message } from "@mariozechner/pi-ai"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { BorderedLoader } from "@mariozechner/pi-coding-agent"
import { mkdir, writeFile, access } from "node:fs/promises"
import { join } from "node:path"

const PROMPT_AUTHOR_SYSTEM = `\
You are an expert at writing purpose-driven system prompts for AI coding agents.

Given a user's description of goal(s) for the agent, write a concise, accurate system prompt for it.

Rules:
- Only write the system prompt; no preamble, no explanation, no surrounding quotes
- Be specific and actionable: tell the agent exactly what it is, what it should do, and any important constraints
- Keep it tight: cover the essential role or personality, key behaviors/demeanor, and any must-have guidelines
- Use plain prose or a short bulleted list; avoid unnecessary headers
- Do NOT include instructions that pi already provides by default (file editing, bash, reading files, etc.)
`

export default function (pi: ExtensionAPI) {
  pi.registerCommand("eject", {
    description: "Scaffold .pi/SYSTEM.md with a purpose-built system prompt",
    handler: async (args, ctx) => {
      const piDir = join(ctx.cwd, ".pi")
      const systemMdPath = join(piDir, "SYSTEM.md")

      // Check if SYSTEM.md already exists
      let alreadyExists = false
      try {
        await access(systemMdPath)
        alreadyExists = true
      } catch {
        /* doesn't exist yet, all good */
      }

      if (alreadyExists) {
        if (!ctx.hasUI) {
          // Non-interactive: hard fail to avoid clobbering existing prompt
          throw Error(`${systemMdPath} already exists. Remove it manually before running eject.`)
        }

        // Interactive: ask for confirmation
        const overwrite = await ctx.ui.confirm(
          "SYSTEM.md already exists",
          `${systemMdPath}\n\nOverwrite it with a new system prompt?`,
        )
        if (!overwrite) {
          ctx.ui.notify("Cancelled.", "info")
          return
        }
      }

      // Resolve the purpose: from args or (interactive only) prompt the user
      let purpose = args.trim()

      if (!purpose) {
        if (!ctx.hasUI) {
          throw Error("No description provided. Pass one as an argument: /eject <description>")
        }
        purpose = (await ctx.ui.input("What should this agent do?")).trim()
        if (!purpose) {
          ctx.ui.notify("No purpose provided — cancelled.", "info")
          return
        }
      }

      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error")
        return
      }

      // Helper: run the LLM completion for a given purpose string
      const generatePrompt = async (signal?: AbortSignal): Promise<string | null> => {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!)
        if (!auth.ok || !auth.apiKey) {
          throw new Error(auth.ok ? `No API key for ${ctx.model!.provider}` : (auth as any).error)
        }

        const userMessage: Message = {
          role: "user",
          content: [{ type: "text", text: purpose }],
          timestamp: Date.now(),
        }

        const response = await complete(
          ctx.model!,
          { systemPrompt: PROMPT_AUTHOR_SYSTEM, messages: [userMessage] },
          { apiKey: auth.apiKey, headers: auth.headers, signal },
        )

        if (response.stopReason === "aborted") return null

        return response.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n")
      }

      let generated: string | null

      if (ctx.hasUI) {
        // Interactive: show a bordered loader while generating
        generated = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
          const loader = new BorderedLoader(
            tui,
            theme,
            `Drafting system prompt with ${ctx.model!.id}…`,
          )
          loader.onAbort = () => done(null)

          generatePrompt(loader.signal)
            .then(done)
            .catch((err) => {
              console.error("eject: prompt generation failed", err)
              done(null)
            })

          return loader
        })
      } else {
        // Non-interactive: call directly, let errors surface
        generated = await generatePrompt()
      }

      if (generated === null) {
        ctx.ui.notify("Cancelled.", "info")
        return
      }

      // Interactive: confirm before writing
      if (ctx.hasUI) {
        const confirmed = await ctx.ui.confirm("Write this system prompt?\n", generated)
        if (!confirmed) {
          ctx.ui.notify("Cancelled — nothing written.", "info")
          return
        }
      }

      // Write .pi/SYSTEM.md
      await mkdir(piDir, { recursive: true })
      await writeFile(systemMdPath, generated.trimEnd() + "\n", "utf-8")

      ctx.ui.notify(
        [
          "✅ System prompt written!",
          "",
          `  ${systemMdPath}`,
          "",
          "Restart pi (or run /reload) to pick it up.",
        ].join("\n"),
        "success",
      )
    },
  })
}
