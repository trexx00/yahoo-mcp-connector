// Sign-in with Amazon Cognito.
//
// The MCP server never sees your Cognito password. Claude sends you to
// Cognito's own login page, Cognito gives Claude an access token, and Claude
// sends that token with every request. This file:
//   1. reads which Cognito user pool and app client to trust, and
//   2. checks each token: signed by that pool, issued to that app client,
//      an access token (not an ID token), and not expired.
import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

export interface AuthConfig {
  /** The address Claude uses to reach this server, without /mcp. */
  publicUrl: URL;
  region: string;
  userPoolId: string;
  clientId: string;
  /** Your Cognito login domain, e.g. https://yahoo-mcp.auth.us-east-2.amazoncognito.com */
  cognitoDomain: URL;
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing ${name}. See the README section "Set up Cognito".`);
  return v;
}

export function loadAuthConfig(): AuthConfig {
  const userPoolId = required("COGNITO_USER_POOL_ID");
  return {
    publicUrl: new URL(process.env.PUBLIC_URL?.trim() || "http://localhost:3000"),
    // A pool id looks like "us-east-2_AbC123", so the region is the part before "_".
    region: userPoolId.split("_")[0],
    userPoolId,
    clientId: required("COGNITO_CLIENT_ID"),
    cognitoDomain: new URL(required("COGNITO_DOMAIN")),
  };
}

export function cognitoVerifier(auth: AuthConfig): OAuthTokenVerifier {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: auth.userPoolId,
    tokenUse: "access",
    clientId: auth.clientId,
  });
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      try {
        const payload = await verifier.verify(token);
        return {
          token,
          clientId: String(payload.client_id),
          scopes: typeof payload.scope === "string" ? payload.scope.split(" ") : [],
          expiresAt: payload.exp,
          extra: { username: payload.username, sub: payload.sub },
        };
      } catch {
        // Don't reveal why a token failed; just ask the client to sign in again.
        throw new InvalidTokenError("Invalid or expired token");
      }
    },
  };
}

/**
 * The "where to sign in" document Claude reads (RFC 8414). It points at
 * Cognito's real login and token pages. We publish it ourselves because
 * Claude requires it to state PKCE support (S256), which Cognito's own
 * published settings may not include.
 */
export function authorizationServerMetadata(auth: AuthConfig) {
  const cognito = (path: string) => new URL(path, auth.cognitoDomain).href;
  return {
    issuer: auth.publicUrl.href.replace(/\/$/, ""),
    authorization_endpoint: cognito("/oauth2/authorize"),
    token_endpoint: cognito("/oauth2/token"),
    revocation_endpoint: cognito("/oauth2/revoke"),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["openid"],
  };
}
