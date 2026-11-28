// Where the read-only connector lives on the Worker (ADR 0040).

/** The OAuth authorization server's endpoints. The Worker's origin is its issuer. */
export const AUTHORIZE_PATH = "/oauth/authorize";
export const TOKEN_PATH = "/oauth/token";
export const REGISTER_PATH = "/oauth/register";
export const AUTHORIZATION_SERVER_METADATA = "/.well-known/oauth-authorization-server";
export const PROTECTED_RESOURCE_METADATA = "/.well-known/oauth-protected-resource";

/** `/r/<owner>/<repo>/mcp`: a Channel's MCP endpoint. */
export const MCP_PATH = /^\/r\/([^/]+\/[^/]+)\/mcp$/;

/** The MCP endpoint of the Channel of `repo`, as typed. */
export function mcpPath(repo: string): string {
  return `/r/${repo}/mcp`;
}

/** The protected resource metadata of the MCP endpoint at `path` (RFC 9728's path-inserted form). */
export function resourceMetadataPath(path: string): string {
  return `${PROTECTED_RESOURCE_METADATA}${path}`;
}

/** The only scope the connector grants: reading the Channel. */
export const MCP_SCOPE = "channel:read";
