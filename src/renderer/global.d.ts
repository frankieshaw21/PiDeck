import type { DesktopApi } from "../desktop/ipc-contract.js";

declare global {
  interface Window { piHarness: DesktopApi }
}
export {};
