// Plugin registry. Each built-in plugin is a clean-room rewrite of an OMO
// component, retuned for GLM. Plugins subscribe to hook events; the engine
// fires them in registration order.
import rules from "./rules.js";
import consequencePredictor from "./consequence-predictor.js";
import commentChecker from "./comment-checker.js";
import executorVerify from "./executor-verify.js";
import startWorkContinuation from "./start-work-continuation.js";
import ulwLoop from "./ulw-loop.js";
import ulwPlan from "./ulw-plan.js";
import telemetry from "./telemetry.js";
import initDeep from "./init-deep.js";

export const BUILTIN_PLUGINS = [
  telemetry,
  rules,
  consequencePredictor,
  commentChecker,
  executorVerify,
  startWorkContinuation,
  ulwLoop,
  ulwPlan,
  initDeep,
];

export const PLUGIN_BY_NAME = Object.fromEntries(BUILTIN_PLUGINS.map((p) => [p.name, p]));

export function loadPlugins(names) {
  if (!names || names.length === 0) return BUILTIN_PLUGINS;
  const want = new Set(names);
  return BUILTIN_PLUGINS.filter((p) => want.has(p.name));
}
