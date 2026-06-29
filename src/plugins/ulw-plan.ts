// ulw-plan — Prometheus-style planner. Detects `$ulw-plan` on UserPromptSubmit
// and injects the planner directive: produce a decision-complete plan to
// plans/<slug>.md without writing product code. The actual plan file is
// written by the GLM agent via tools; this plugin only sets the contract.
import { slugify } from "../util.js";
import type { HookPlugin } from "../types/index.js";

export function isPlanRequest(prompt: string): boolean {
  return /\$ulw-plan\b/i.test(prompt || "");
}

export default {
  name: "ulw-plan",
  hooks: {
    async UserPromptSubmit(input, api) {
      const prompt = typeof input.prompt === "string" ? input.prompt : "";
      if (!isPlanRequest(prompt)) return undefined;
      const taskBody = prompt.replace(/\$ulw-plan\b/i, "").trim();
      const slug = slugify(taskBody.split("\n")[0]) || "plan";
      return {
        inject: `PLANNER MODE. Write a decision-complete implementation plan to plans/${slug}.md. Use a markdown checklist (- [ ] item). Cover: goal, architecture, file-by-file tasks, verification steps, risks. Do NOT write or modify product code — only the plan file. When the plan is written, call finish with the plan path.`,
      };
    },
  },
} satisfies HookPlugin;
