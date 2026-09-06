/**
 * Opening the system browser, and refusing honestly when there isn't one.
 *
 * **The headless case is the whole reason this file has more than four lines.**
 * The portal's authorization server advertises `authorization_code` and
 * `refresh_token` and nothing else — there is **no device authorization grant**
 * (RFC 8628), so a machine with no browser cannot complete this flow at all.
 * That is a portal v1 decision, documented in its `docs/api-contract.md` §1, not
 * an oversight, and the portal's sketched future shape is a device-style
 * approval page that mints a Clerk-managed API key.
 *
 * So this module must NOT build a headless path, and must not let a headless
 * machine discover the problem as a five-minute timeout on a listener nobody
 * will ever hit. It checks first and says what is true.
 *
 * **Cross-platform, argument-array spawn.** No shell is involved on any
 * platform, which matters more than usual here: the authorization URL is full of
 * `&`, and on Windows a shell would treat those as command separators. The
 * Windows opener is `rundll32 url.dll,FileProtocolHandler`, which takes the URL
 * as one argument; `cmd /c start` would put it back through a parser.
 */

import { spawn } from "node:child_process";
import { PortalAuthError } from "./errors.js";

/** The seam. `golem team link --no-browser` swaps in a printer. */
export interface BrowserOpener {
  open(url: string): Promise<void>;
}

export interface PlatformProbe {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Whether this machine plausibly has a browser a user can see.
 *
 * Only the X11/Wayland absence is treated as proof: on Windows and macOS a
 * process without a desktop session is unusual enough that guessing wrong in
 * that direction would block working machines.
 */
export function hasDisplay(probe: PlatformProbe = {}): boolean {
  const platform = probe.platform ?? process.platform;
  const env = probe.env ?? process.env;
  if (platform === "win32" || platform === "darwin") return true;
  return (
    (env.DISPLAY !== undefined && env.DISPLAY !== "") ||
    (env.WAYLAND_DISPLAY !== undefined && env.WAYLAND_DISPLAY !== "")
  );
}

/** The message a headless machine gets. Stated as fact, not as a workaround. */
export const HEADLESS_MESSAGE =
  "this machine has no graphical session (no DISPLAY, no WAYLAND_DISPLAY), and portal " +
  "sign-in needs a browser. There is no headless path: the portal's authorization server " +
  "supports the authorization_code and refresh_token grants only — it advertises no device " +
  "authorization grant (RFC 8628), so a machine with no browser cannot complete this flow. " +
  "Run `golem team link` on a machine with a browser. If you are on an SSH session with " +
  "port forwarding to this host, forward the port Golem prints and pass --no-browser.";

/** The command that opens a URL in the user's default handler, per platform. */
export function openerCommand(platform: NodeJS.Platform): { file: string; args: string[] } {
  switch (platform) {
    case "darwin":
      return { file: "open", args: [] };
    case "win32":
      // One argument, no shell, no re-parsing of `&`.
      return { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler"] };
    default:
      return { file: "xdg-open", args: [] };
  }
}

export interface SystemBrowserOptions extends PlatformProbe {
  /** Injected for tests; defaults to `node:child_process` spawn. */
  readonly spawnImpl?: typeof spawn;
}

/**
 * The real opener: hands the URL to the platform's default-handler launcher.
 *
 * Resolves once the child process has actually started (Node's `spawn` event),
 * so a missing `xdg-open` fails here rather than silently doing nothing while
 * the listener waits out its deadline.
 */
export function systemBrowser(options: SystemBrowserOptions = {}): BrowserOpener {
  const platform = options.platform ?? process.platform;
  const spawnImpl = options.spawnImpl ?? spawn;
  return {
    open: async (url) => {
      if (!hasDisplay({ platform, ...(options.env === undefined ? {} : { env: options.env }) })) {
        throw new PortalAuthError("no_browser", HEADLESS_MESSAGE);
      }
      const { file, args } = openerCommand(platform);
      const child = spawnImpl(file, [...args, url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      try {
        await new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("spawn", resolve);
        });
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new PortalAuthError(
          "no_browser",
          `could not open a browser with \`${file}\`: ${why}. ` +
            "Re-run with --no-browser and open the printed URL yourself.",
        );
      }
      // Do not hold the CLI open waiting on the browser to exit.
      child.unref();
    },
  };
}

/**
 * `--no-browser`: print the URL and let the user open it.
 *
 * Still only useful on (or forwarded to) the machine running the listener — the
 * redirect goes to this host's loopback interface. It is the escape hatch for a
 * machine that HAS a browser but whose launcher Golem cannot invoke, not a
 * headless path.
 */
export function printingBrowser(write: (text: string) => void): BrowserOpener {
  return {
    open: async (url) => {
      write(`\nOpen this URL in a browser on this machine to finish signing in:\n\n  ${url}\n\n`);
    },
  };
}
