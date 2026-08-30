/**
 * Command registration only — action handler logic lives in src/cli/commands/.
 * Extracted from a 3618-line file (R8.27).
 */
import { Command } from "commander";
import { findProjectDir } from "../config/index.js";
import { VERSION } from "../index.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

const program = new Command();

program
  .name("golem")
  .description("Golem — universal pre-LLM processing layer (golem.run)")
  .version(VERSION);

program.addHelpText(
  "after",
  `\nControl panel:\n  golem                     open the interactive control panel\n  golem --dir <path>        open it for another project\n  golem --no-pet            hide the pet in the header\n  golem --advanced          show advanced controls on open`,
);

import register_autonomy from "./commands/autonomy.js";
import register_bench from "./commands/bench.js";
import register_checkpoint from "./commands/checkpoint.js";
import register_config from "./commands/config.js";
import register_device from "./commands/device.js";
import register_dials_stats from "./commands/dials-stats.js";
import registerGatewayCommands from "./commands/gateway.js";
import register_init_uninit from "./commands/init-uninit.js";
import register_local_ollama from "./commands/local-ollama.js";
import register_mcp_serve from "./commands/mcp-serve.js";
import register_note_dashboard_watch from "./commands/note-dashboard-watch.js";
import register_pkg_models from "./commands/pkg-models.js";
import register_plugin from "./commands/plugin.js";
import register_prompt_guidance from "./commands/prompt-guidance.js";
import register_proxy from "./commands/proxy.js";
import register_session from "./commands/session.js";
import register_status_update from "./commands/status-update.js";
import register_personas from "./commands/personas.js";
import register_target from "./commands/target.js";
import register_tasks from "./commands/tasks.js";
import register_wiki from "./commands/wiki.js";

register_init_uninit(program);
register_wiki(program);
register_proxy(program);
register_mcp_serve(program);
register_status_update(program);
register_session(program);
register_device(program);
register_dials_stats(program);
register_bench(program);
register_checkpoint(program);
register_pkg_models(program);
register_plugin(program);
registerGatewayCommands(program);
register_personas(program);
register_target(program);
register_note_dashboard_watch(program);
register_tasks(program);
register_autonomy(program);
register_prompt_guidance(program);
register_config(program);
register_local_ollama(program);

export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  await program.parseAsync([...argv]);
}
