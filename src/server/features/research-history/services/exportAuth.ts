import { env } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { getAuthMode, usesBetterAuth } from "@/lib/auth-mode";
import { ensureSharedWorkspaceOrganization } from "@/server/auth/delegated-organization";
import { resolveLocalNoAuthContext } from "@/middleware/ensure-user/delegated";
import { authenticateApiKey, getApiKey } from "@/server/mcp/api-key-auth";

// Who may read the export API (researchExport.ts), and for which organization.
//
// - hosted / password: the org-bound `oseo_` API key from Settings, verified
//   exactly as /mcp verifies it (same organization binding, live membership
//   check and rate limit). The export reads no more than that key's MCP tools.
// - local_noauth / cloudflare_access: these modes have no accounts and no API
//   keys; whoever reaches the app is the admin. The export still needs a key:
//   OPENSEO_EXPORT_KEY, a deployment secret, sent as `x-api-key` (never
//   `Authorization`, which a reverse proxy's basic auth or Cloudflare Access
//   may own). It reads the one workspace those modes have. Unset, the export
//   is off.
// - everyapp: off; the gateway owns identity and issues no such keys.

const MIN_EXPORT_KEY_LENGTH = 32;

type ExportAuth = { organizationId: string } | { response: Response };

function errorResponse(status: number, error: string, description: string) {
  return new Response(
    JSON.stringify({ error, error_description: description }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function matchesExportKey(supplied: string | null) {
  const secret: unknown = Reflect.get(env, "OPENSEO_EXPORT_KEY");
  if (typeof secret !== "string" || secret.length < MIN_EXPORT_KEY_LENGTH)
    return null;
  if (!supplied) return false;
  const expectedBytes = Buffer.from(secret);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

export async function authenticateExportRequest(
  request: Request,
): Promise<ExportAuth> {
  const authMode = getAuthMode(env.AUTH_MODE);

  if (usesBetterAuth(authMode)) {
    const apiKey = getApiKey(request);
    if (!apiKey)
      return {
        response: errorResponse(
          401,
          "invalid_api_key",
          "Send an OpenSEO API key (oseo_...) as x-api-key or a Bearer token.",
        ),
      };
    const auth = await authenticateApiKey(apiKey, env);
    if ("response" in auth) return auth;
    return { organizationId: auth.identity.organizationId };
  }

  if (authMode === "local_noauth" || authMode === "cloudflare_access") {
    const matches = matchesExportKey(request.headers.get("x-api-key"));
    if (matches === null)
      return {
        response: errorResponse(
          404,
          "export_disabled",
          "Set OPENSEO_EXPORT_KEY (32+ characters) to turn on the export API.",
        ),
      };
    if (!matches)
      return {
        response: errorResponse(
          401,
          "invalid_api_key",
          "Send the deployment's OPENSEO_EXPORT_KEY as x-api-key.",
        ),
      };
    const organizationId =
      authMode === "local_noauth"
        ? (await resolveLocalNoAuthContext()).organizationId
        : await ensureSharedWorkspaceOrganization();
    return { organizationId };
  }

  return {
    response: errorResponse(
      404,
      "export_disabled",
      "The export API is not available in this deployment mode.",
    ),
  };
}
