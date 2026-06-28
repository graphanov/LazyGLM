import { discoverScaffold, formatHandoffInject, readHandoffText } from "../scaffold/handoff.js";

export default {
  name: "scaffold-handoff",
  hooks: {
    async SessionStart(_input, api) {
      const scaffold = discoverScaffold(api.cwd);
      if (!scaffold.present) return undefined;

      try {
        const handoff = await readHandoffText(api.cwd);
        if (!handoff) {
          api.log(`[scaffold-handoff] Open Scaffold records present (${scaffold.sources.join(", ")}) but no readable handoff text (.osc/handoff.md or MISSION.md)`);
          return undefined;
        }
        return { inject: formatHandoffInject(handoff) };
      } catch (err) {
        api.log(`[scaffold-handoff] could not read Open Scaffold handoff: ${err?.message || err}`);
        return undefined;
      }
    },
  },
};
