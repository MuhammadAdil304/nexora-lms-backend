import { SignOptions, sign, verify } from "jsonwebtoken";
import crypto from "crypto";
import { Response } from "express";
import { database } from "../config/database";
import { env } from "../config/env";
import { redis, isRedisReady } from "../config/redis";
import { logger } from "../utils/logger";
import { AppError } from "../utils/http";
import { RowDataPacket, ResultSetHeader } from "mysql2";

export interface AccessTokenPayload {
  sub: string; // user id
  role: string;
  type: "access";
  exp?: number;
  iat?: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number; // Unix timestamp (seconds)
  refreshTokenExpiresAt: number;
}

/** Hash a token for storage (never store raw tokens) */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Generate a secure random (opaque) refresh token */
function generateSecureToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Calculate expiry timestamp from duration string (e.g., "15m", "7d") */
export function parseExpiryToSeconds(expiry: string): number {
  const match = expiry.match(/^(\d+)([smhd])$/);
  if (!match) return 15 * 60; // default 15 minutes
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "s": return value;
    case "m": return value * 60;
    case "h": return value * 60 * 60;
    case "d": return value * 24 * 60 * 60;
    default: return 15 * 60;
  }
}

const ACCESS_TOKEN_EXPIRY_SECONDS = parseExpiryToSeconds(env.jwtExpiresIn);
const REFRESH_TOKEN_EXPIRY_SECONDS = parseExpiryToSeconds(env.jwtRefreshExpiresIn);

/** Sign an access token (short-lived JWT) */
export function signAccessToken(userId: number, role: string): string {
  const payload: AccessTokenPayload = { sub: String(userId), role, type: "access" };
  const options: SignOptions = { expiresIn: env.jwtExpiresIn as SignOptions["expiresIn"] };
  return sign(payload, env.jwtSecret, options);
}

/** Verify access token JWT */
export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = verify(token, env.jwtSecret, { algorithms: ["HS256"] }) as AccessTokenPayload;
  if (decoded.type !== "access") throw new AppError("Invalid token type", 401, "INVALID_TOKEN_TYPE");
  return decoded;
}

/** Create token pair and persist the opaque refresh token (hash only) */
export async function createTokenPair(userId: number, role: string, userAgent?: string, ip?: string): Promise<TokenPair> {
  const refreshToken = generateSecureToken();
  const refreshTokenHash = hashToken(refreshToken);
  const accessToken = signAccessToken(userId, role);

  const now = Math.floor(Date.now() / 1000);
  const accessTokenExpiresAt = now + ACCESS_TOKEN_EXPIRY_SECONDS;
  const refreshTokenExpiresAt = now + REFRESH_TOKEN_EXPIRY_SECONDS;

  // Store refresh token hash in database (source of truth)
  await database.execute<ResultSetHeader>(
    `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip_address, expires_at)
     VALUES (?, ?, ?, ?, FROM_UNIXTIME(?))`,
    [userId, refreshTokenHash, userAgent ?? null, ip ?? null, refreshTokenExpiresAt]
  );

  // Mirror in Redis for fast revocation checks (with TTL). Best-effort:
  // if Redis is unavailable the database remains authoritative.
  if (isRedisReady()) {
    try {
      await redis.setex(
        `refresh_token:${refreshTokenHash}`,
        REFRESH_TOKEN_EXPIRY_SECONDS,
        JSON.stringify({ userId, revoked: false })
      );
    } catch (err) {
      logger.warn({ err }, "Failed to mirror refresh token in Redis");
    }
  }

  logger.info({ userId }, "Token pair created");

  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
  };
}

/**
 * Validate an opaque refresh token against the database and rotate it
 * (issue a new pair, revoke the old one). Refresh tokens are NOT JWTs,
 * so they are identified purely by their hash.
 */
export async function rotateRefreshToken(refreshToken: string, userAgent?: string, ip?: string): Promise<TokenPair> {
  const tokenHash = hashToken(refreshToken);

  // Verify in database (authoritative store)
  const [rows] = await database.execute<RowDataPacket[]>(
    `SELECT id, user_id, revoked_at, expires_at FROM refresh_tokens WHERE token_hash = ? LIMIT 1`,
    [tokenHash]
  );

  const stored = rows[0];
  if (!stored) {
    throw new AppError("Invalid refresh token", 401, "INVALID_REFRESH_TOKEN");
  }
  if (stored.revoked_at) {
    throw new AppError("Token has been revoked", 401, "TOKEN_REVOKED");
  }
  if (new Date(stored.expires_at).getTime() / 1000 < Math.floor(Date.now() / 1000)) {
    throw new AppError("Refresh token expired", 401, "REFRESH_TOKEN_EXPIRED");
  }

  const userId = Number(stored.user_id);

  // Revoke the used token before issuing the replacement
  await revokeRefreshToken(tokenHash);

  // Get user role/status for the new access token
  const [userRows] = await database.execute<RowDataPacket[]>(
    "SELECT role, status FROM users WHERE id = ? LIMIT 1",
    [userId]
  );
  const user = userRows[0];
  if (!user) {
    throw new AppError("User not found", 404, "USER_NOT_FOUND");
  }
  if (user.status === "suspended") {
    throw new AppError("Your account has been suspended", 403, "ACCOUNT_SUSPENDED");
  }

  return createTokenPair(userId, user.role, userAgent, ip);
}

/** Revoke a refresh token (logout / rotation) */
export async function revokeRefreshToken(tokenHash: string): Promise<void> {
  await database.execute<ResultSetHeader>(
    "UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND revoked_at IS NULL",
    [tokenHash]
  );

  if (isRedisReady()) {
    try {
      await redis.del(`refresh_token:${tokenHash}`);
    } catch (err) {
      logger.warn({ err }, "Failed to remove refresh token from Redis");
    }
  }

  logger.info({ tokenHash: tokenHash.substring(0, 8) + "..." }, "Refresh token revoked");
}

/** Revoke all refresh tokens for a user (logout everywhere / suspension) */
export async function revokeAllUserTokens(userId: number): Promise<void> {
  const [rows] = await database.execute<RowDataPacket[]>(
    "SELECT token_hash FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL",
    [userId]
  );

  await database.execute<ResultSetHeader>(
    "UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL",
    [userId]
  );

  if (isRedisReady()) {
    try {
      if (rows.length) {
        const keys = rows.map((row) => `refresh_token:${row.token_hash}`);
        await redis.del(...keys);
      }
    } catch (err) {
      logger.warn({ err }, "Failed to clear refresh tokens from Redis");
    }
  }

  logger.info({ userId, count: rows.length }, "All user tokens revoked");
}

/** Check if an access token was revoked (Redis blacklist; fail-open when Redis is down) */
export async function isAccessTokenRevoked(token: string): Promise<boolean> {
  if (!isRedisReady()) return false;
  try {
    const result = await redis.get(`access_token_revoked:${token}`);
    return result === "1";
  } catch (err) {
    logger.warn({ err }, "Redis blacklist check failed; allowing request");
    return false;
  }
}

/** Revoke an access token (blacklist it until its natural expiry) */
export async function revokeAccessToken(token: string): Promise<void> {
  if (!isRedisReady()) return;
  let ttl = ACCESS_TOKEN_EXPIRY_SECONDS;
  try {
    const decoded = verifyAccessToken(token);
    ttl = (decoded.exp ?? Math.floor(Date.now() / 1000) + ACCESS_TOKEN_EXPIRY_SECONDS) - Math.floor(Date.now() / 1000);
  } catch {
    // Invalid/expired token — nothing meaningful to blacklist
    return;
  }
  if (ttl <= 0) return;
  try {
    await redis.setex(`access_token_revoked:${token}`, ttl, "1");
  } catch (err) {
    logger.warn({ err }, "Failed to blacklist access token in Redis");
  }
}

/** Clean up expired refresh tokens (run periodically) */
export async function cleanupExpiredTokens(): Promise<number> {
  const [result] = await database.execute<ResultSetHeader>(
    "DELETE FROM refresh_tokens WHERE expires_at < CURRENT_TIMESTAMP"
  );
  if (result.affectedRows > 0) {
    logger.info({ deleted: result.affectedRows }, "Cleaned up expired refresh tokens");
  }
  return result.affectedRows;
}

const ACCESS_COOKIE_MAX_AGE_MS = ACCESS_TOKEN_EXPIRY_SECONDS * 1000;
const REFRESH_COOKIE_MAX_AGE_MS = REFRESH_TOKEN_EXPIRY_SECONDS * 1000;

/** Set HttpOnly auth cookies on the response */
export function setAuthCookies(response: Response, accessToken: string, refreshToken: string): void {
  const isProduction = process.env.NODE_ENV === "production";

  response.cookie("access_token", accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: ACCESS_COOKIE_MAX_AGE_MS,
    path: "/",
  });

  response.cookie("refresh_token", refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    path: "/",
  });
}

/** Clear auth cookies */
export function clearAuthCookies(response: Response): void {
  response.clearCookie("access_token", { path: "/" });
  response.clearCookie("refresh_token", { path: "/" });
}
