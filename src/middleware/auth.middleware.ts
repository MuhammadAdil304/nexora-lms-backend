import { NextFunction, Request, Response } from "express";
import { RowDataPacket } from "mysql2";
import { database } from "../config/database";
import { env } from "../config/env";
import { AppError } from "../utils/http";
import { AuthenticatedUser, UserRole, UserStatus } from "../types/user";
import { verifyAccessToken, isAccessTokenRevoked } from "../utils/tokens";
import { logger } from "../utils/logger";

interface UserRow extends RowDataPacket, AuthenticatedUser {}

/** Extract token from cookie or Authorization header */
function extractToken(request: Request): string | null {
  // Prefer HttpOnly cookie
  if (request.cookies?.access_token) {
    return request.cookies.access_token;
  }
  // Fallback to Authorization header (for API clients)
  const header = request.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }
  return null;
}

export async function authenticate(
  request: Request,
  _response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = extractToken(request);
    if (!token) {
      throw new AppError("Authentication token is required", 401, "UNAUTHORIZED");
    }

    if (await isAccessTokenRevoked(token)) {
      throw new AppError("Token has been revoked. Please sign in again.", 401, "TOKEN_REVOKED");
    }

    const decoded = verifyAccessToken(token);
    const id = Number(decoded.sub);
    if (!Number.isSafeInteger(id) || !decoded.role) {
      throw new AppError("Invalid authentication token", 401, "UNAUTHORIZED");
    }

    const [rows] = await database.execute<UserRow[]>(
      "SELECT id, name, first_name AS firstName, last_name AS lastName, phone, email, role, status FROM users WHERE id = ? LIMIT 1",
      [id],
    );
    const user = rows[0];
    if (!user) {
      throw new AppError("User account was not found", 401, "UNAUTHORIZED");
    }

    request.user = {
      id: Number(user.id),
      name: user.name,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      phone: user.phone ?? null,
      email: user.email,
      role: user.role,
      status: user.status as UserStatus,
    };
    next();
  } catch (error) {
    logger.warn({ err: error, path: request.path }, "Authentication failed");
    next(error instanceof AppError ? error : new AppError("Invalid authentication token", 401, "UNAUTHORIZED"));
  }
}

export async function optionalAuth(
  request: Request,
  _response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = extractToken(request);
    if (!token) {
      return next();
    }

    if (await isAccessTokenRevoked(token)) {
      return next();
    }

    const decoded = verifyAccessToken(token);
    const id = Number(decoded.sub);
    if (!Number.isSafeInteger(id) || !decoded.role) {
      return next();
    }

    const [rows] = await database.execute<UserRow[]>(
      "SELECT id, name, first_name AS firstName, last_name AS lastName, phone, email, role, status FROM users WHERE id = ? LIMIT 1",
      [id],
    );
    const user = rows[0];
    if (user) {
      request.user = {
        id: Number(user.id),
        name: user.name,
        firstName: user.firstName ?? null,
        lastName: user.lastName ?? null,
        phone: user.phone ?? null,
        email: user.email,
        role: user.role,
        status: user.status as UserStatus,
      };
    }
    next();
  } catch (error) {
    // If token verification fails, just ignore and proceed without setting user
    next();
  }
}

export function requireRoles(...roles: UserRole[]) {
  return (request: Request, _response: Response, next: NextFunction): void => {
    if (!request.user) {
      next(new AppError("Authentication token is required", 401, "UNAUTHORIZED"));
      return;
    }
    if (!roles.includes(request.user.role)) {
      next(new AppError("You do not have permission to perform this action", 403, "FORBIDDEN"));
      return;
    }
    next();
  };
}

export function requireActiveAccount(
  request: Request,
  _response: Response,
  next: NextFunction,
): void {
  if (!request.user) {
    next(new AppError("Authentication token is required", 401, "UNAUTHORIZED"));
    return;
  }
  if (request.user.status !== "active") {
    next(new AppError("Your account is not active", 403, "ACCOUNT_NOT_ACTIVE"));
    return;
  }
  next();
}

export function requireActiveInstructor(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (request.user?.role === "admin") {
    next();
    return;
  }
  if (request.user?.role !== "instructor" || request.user.status !== "active") {
    next(new AppError("Only active instructors can perform this action", 403, "INSTRUCTOR_NOT_ACTIVE"));
    return;
  }
  next();
}
