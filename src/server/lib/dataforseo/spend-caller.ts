import { AsyncLocalStorage } from "node:async_hooks";

// Who a DataForSEO call is for, as a label on the spend ledger
// (spend-cap.ts): "mcp:<tool> (<client>)" for an MCP tool call, "app" for any
// other HTTP request (the UI's server functions), "cron" for the scheduled
// handler, and "background" for work no request started (Workflows). A display
// label only: nothing authorizes or refuses on it. An MCP client's label is
// its User-Agent product token, so a caller can name itself with one.

const MAX_CALLER_CHARS = 120;
const callers = new AsyncLocalStorage<string>();

export function runAsDataforseoCaller<T>(caller: string, fn: () => T): T {
  return callers.run(caller.slice(0, MAX_CALLER_CHARS), fn);
}

export function currentDataforseoCaller(): string {
  return callers.getStore() ?? "background";
}
