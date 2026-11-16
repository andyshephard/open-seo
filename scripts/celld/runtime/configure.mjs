import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const root = "/config";
await mkdir(root, { recursive: true, mode: 0o700 });
const secretsFile = `${root}/secrets.json`;
let secrets;
try {
  secrets = JSON.parse(await readFile(secretsFile, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  secrets = Object.fromEntries(
    [
      "BETTER_AUTH_SECRET",
      "OPENSEO_OPERATOR_SECRET",
      "CRAWL_GATEWAY_SECRET",
    ].map((key) => [key, randomBytes(32).toString("hex")]),
  );
  await writeFile(secretsFile, JSON.stringify(secrets), {
    mode: 0o600,
    flag: "wx",
  });
}
// password: email and password accounts (the first visitor creates the
// admin's, invitations add the rest). local_noauth: no sign-in and one admin
// user, as the old Docker image ran (private networks only).
const authMode = process.env.AUTH_MODE || "password";
if (!["password", "local_noauth"].includes(authMode))
  throw new Error("AUTH_MODE must be password or local_noauth");
const url = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3001");
if (
  url.protocol !== "https:" &&
  !(
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
) {
  throw new Error("BETTER_AUTH_URL must use HTTPS, except on loopback");
}
if (
  url.pathname !== "/" ||
  url.search ||
  url.hash ||
  url.username ||
  url.password
)
  throw new Error("BETTER_AUTH_URL must be an origin");
// Start from an empty app dir: cp merges, so a file the new image dropped or
// renamed (an old migration, say) would stay in the volume, and `celld d1
// migrations apply` would run it again.
await rm(`${root}/app`, { recursive: true, force: true });
await cp("/opt/openseo", `${root}/app`, { recursive: true });
const config = JSON.parse(await readFile(`${root}/app/wrangler.json`, "utf8"));
const allowed = [
  "DATAFORSEO_API_KEY",
  "CONTEXT_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_MODEL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_MAPS_API_KEY",
  "CRAWLER_ACCESS_SECRET",
  // Turns on the research export API with AUTH_MODE=local_noauth.
  "OPENSEO_EXPORT_KEY",
  // Monthly DataForSEO spend cap in USD (default 25 when unset).
  "DATAFORSEO_MONTHLY_CAP_USD",
];
config.vars = {
  ...secrets,
  BETTER_AUTH_URL: url.origin,
  CRAWL_GATEWAY_URL: "http://crawl-gateway:8090",
  AUTH_MODE: authMode,
  DATABASE_PROVIDER: "d1",
  OPENSEO_TELEMETRY_DISABLED: "true",
  DO_NOT_TRACK: "1",
};
for (const key of allowed)
  if (process.env[key]) config.vars[key] = process.env[key];
await writeFile(`${root}/app/wrangler.json`, JSON.stringify(config), {
  mode: 0o600,
});
console.log(
  `Standalone configuration prepared for AUTH_MODE=${authMode} (secret values omitted).`,
);
