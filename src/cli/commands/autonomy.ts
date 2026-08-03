import { Command } from "commander";
import { findProjectDir } from "../../config/index.js";

const DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

function fail(err: unknown): never {
  process.stderr.write("golem: " + (err instanceof Error ? err.message : String(err)) + "\n");
  process.exit(2);
}

export default function register(program: Command): void {

}
