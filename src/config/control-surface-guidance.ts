/**
 * The GUIDANCE third of the control surface: `.claude/rules/golem-<name>.md`,
 * where the presence of the file IS the toggle.
 *
 * Split out of control-surface.ts (R10.1) by store — read half and write half
 * together. See control-surface-settings.ts for the reasoning.
 */

import path from "node:path";
// `../hooks/guidance.js`, not the `../hooks/index.js` barrel: the barrel pulls
// every hook handler (~446ms vs ~117ms) and all we need here is the feature table
// plus the rule read/write helpers.
import {
  GUIDANCE_FEATURES,
  type GuidanceScope,
  guidanceRuleExists,
  removeGuidanceRule,
  writeGuidanceRule,
} from "../hooks/guidance.js";
import {
  type ApplyResult,
  type Control,
  type ControlGroup,
  GUIDANCE_SCOPES,
} from "./control-surface-types.js";
import { ConfigError } from "./errors.js";

/** The guidance rules, with the scope each is currently enabled at. */
export async function guidanceControlGroup(projectDir: string): Promise<ControlGroup> {
  const controls: Control[] = await Promise.all(
    GUIDANCE_FEATURES.map(async (feature): Promise<Control> => {
      const [project, user] = await Promise.all([
        guidanceRuleExists(projectDir, feature.name, "project"),
        guidanceRuleExists(projectDir, feature.name, "user"),
      ]);
      // Presence IS the toggle; the committed project rule wins the display.
      const layer = project ? "project" : user ? "user" : "default";
      return {
        id: `guidance:${feature.name}`,
        family: "guidance",
        label: feature.name,
        summary: feature.summary,
        detail:
          `Writes .claude/rules/golem-${feature.name}.md, which Claude Code auto-loads every ` +
          `session. ${feature.seededByDefault ? "Seeded by `golem init`." : "Opt-in."} ` +
          "Restart or reload Claude Code to pick up a change.",
        kind: "toggle",
        value: project || user,
        layer,
        ...(layer !== "default" && {
          source: path.join(
            projectDir,
            ".claude",
            "rules",
            project ? `golem-${feature.name}.md` : `golem-${feature.name}.local.md`,
          ),
        }),
        writableScopes: GUIDANCE_SCOPES,
        advanced: false,
      };
    }),
  );

  return {
    id: "guidance",
    title: "Guidance rules",
    summary: "Practices Claude Code is told to follow — a rule file's presence is the toggle",
    tab: "guidance",
    controls,
  };
}
export async function applyGuidance(
  name: string,
  value: unknown,
  scope: string,
  projectDir: string,
): Promise<ApplyResult> {
  const feature = GUIDANCE_FEATURES.find((f) => f.name === name);
  if (feature === undefined) {
    throw new ConfigError(
      `unknown guidance feature "${name}" (try: ${GUIDANCE_FEATURES.map((f) => f.name).join(", ")})`,
      { key: name },
    );
  }
  const target: GuidanceScope = scope === "user" ? "user" : "project";

  if (value === true) {
    const action = await writeGuidanceRule(projectDir, feature, target);
    return {
      id: `guidance:${name}`,
      value: true,
      message: `${name} enabled (${target} scope)`,
      file: action.path,
      restartHint: "restart or reload Claude Code to pick up the rule",
    };
  }
  // Disabling removes BOTH scopes unless the personal scope was asked for
  // explicitly — otherwise a committed rule would silently keep it on.
  const action = await removeGuidanceRule(projectDir, name, scope === "user" ? "user" : "both");
  return {
    id: `guidance:${name}`,
    value: false,
    message:
      action.kind === "skip" ? `${name} was already off` : `${name} disabled (${action.path})`,
    ...(action.kind !== "skip" && { file: action.path }),
    restartHint: "restart or reload Claude Code to drop the rule",
  };
}
