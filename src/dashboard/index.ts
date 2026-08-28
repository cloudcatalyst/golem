/**
 * WS-E: local web dashboard — savings, slider level, stage attribution
 * (owned by agent-ux; task E3, dashboard v0).
 */

export { ICON_SIZES, type IconSize, iconPng, iconSizeForPath } from "./icon.js";
export { type LanAddress, lanAddresses, lanUrls } from "./lan.js";
export type {
  DashboardHandle,
  DashboardOptions,
  DashboardSnapshot,
} from "./server.js";
export {
  LAN_HOST,
  LOOPBACK_HOST,
  MANIFEST_PATH,
  manifestJson,
  REFRESH_MS,
  renderPage,
  STALE_AFTER_MS,
  startDashboard,
} from "./server.js";
