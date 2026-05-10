/**
 * Admin Authentication Middleware
 *
 * Simple bearer token auth for admin dashboard routes.
 * Token is set via ADMIN_TOKEN env var in wrangler.toml.
 */

import type { Context, Next } from "hono";

export function adminAuthMiddleware() {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header("Authorization");
    const token = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
    const expected = c.env.ADMIN_TOKEN as string;

    if (!expected) {
      return c.json({ error: { message: "ADMIN_TOKEN not configured", type: "config_error" } }, 500);
    }

    if (!token || token !== expected) {
      return c.json(
        { error: { message: "Unauthorized", type: "auth_error", code: "invalid_admin_token" } },
        401
      );
    }

    await next();
  };
}
