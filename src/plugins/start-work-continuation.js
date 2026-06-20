// start-work-continuation — Stop/SubagentStop hook. If an active plan with
// unchecked items exists, surfaces a continuation note so the next run picks
// up where the last left off. Clean-room analog of the OMO boulder-progress
// component.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

export default {
  name: "start-work-continuation",
  hooks: {
    async Stop(input, api) {
      if (input.finished) return undefined;
      const activePath = join(api.cwd, ".lazyglm", "active-plan.json");
      if (!existsSync(activePath)) return undefined;
      try {
        const active = JSON.parse(await readFile(activePath, "utf8"));
        const planAbs = join(api.cwd, active.planPath);
        if (!existsSync(planAbs)) return undefined;
        const plan = await readFile(planAbs, "utf8");
        const unchecked = (plan.match(/-\s+\[\s\]/g) || []).length;
        const checked = (plan.match(/-\s+\[x\]/gi) || []).length;
        if (unchecked > 0) {
          return {
            feedback: `start-work-continuation: active plan '${active.planPath}' has ${checked}/${checked + unchecked} items done (${unchecked} remaining). Resume with: lazyglm run --plan ${active.planPath}`,
          };
        }
      } catch {
        // corrupt active-plan; ignore
      }
      return undefined;
    },
  },
};
