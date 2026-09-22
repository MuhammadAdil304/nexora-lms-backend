import { Request, Response } from "express";
import { compare, hash } from "bcryptjs";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import { database } from "../config/database";
import { AppError, parsePositiveId, sendSuccess } from "../utils/http";
import { AuthenticatedUser, UserRole, UserStatus } from "../types/user";
import { createTokenPair, rotateRefreshToken, revokeRefreshToken, revokeAccessToken, revokeAllUserTokens, setAuthCookies, clearAuthCookies, hashToken } from "../utils/tokens";
import { logger } from "../utils/logger";
import { notify } from "../utils/notifications";

interface UserRow extends RowDataPacket {
  id: number;
  name: string;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  email: string;
  password_hash?: string;
  role: UserRole;
  status: UserStatus;
  created_at?: Date;
  updated_at?: Date;
  course_count?: number;
  joined_at?: Date;
}

function publicUser(user: UserRow | AuthenticatedUser) {
  const row = user as Partial<UserRow> & Partial<AuthenticatedUser>;
  return {
    id: Number(user.id),
    name: user.name,
    firstName: row.first_name ?? row.firstName ?? null,
    lastName: row.last_name ?? row.lastName ?? null,
    phone: row.phone ?? null,
    email: user.email,
    role: user.role,
    status: user.status,
    ...("created_at" in user && user.created_at ? { createdAt: user.created_at } : {}),
    ...("updated_at" in user && user.updated_at ? { updatedAt: user.updated_at } : {}),
    ...("course_count" in user ? { courseCount: Number(user.course_count ?? 0) } : {}),
    ...("joined_at" in user && user.joined_at ? { joinedAt: user.joined_at } : {}),
  };
}

const PHONE_PATTERN = /^\+?[0-9\s-]{7,20}$/;

function validateCredentials(
  body: unknown,
): { firstName: string; lastName: string; phone: string | null; email: string; password: string } {
  const value = (body ?? {}) as Record<string, unknown>;
  const text = (input: unknown) => (typeof input === "string" ? input.trim() : "");
  const firstName = text(value.firstName);
  const lastName = text(value.lastName);
  // Legacy clients only send `name`/`username` — split it into first/last.
  const legacy = text(value.name) || text(value.username);
  const legacyParts = legacy.split(/\s+/).filter(Boolean);
  const first = firstName || legacyParts[0] || "";
  const last = lastName || legacyParts.slice(1).join(" ");
  const phone = text(value.phone) || null;
  const email = text(value.email).toLowerCase();
  const password = typeof value.password === "string" ? value.password : "";

  if (!first || !email || !password) {
    throw new AppError("firstName, email, and password are required", 400, "VALIDATION_ERROR");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AppError("email must be valid", 400, "VALIDATION_ERROR");
  }
  if (phone && !PHONE_PATTERN.test(phone)) {
    throw new AppError("phone must be a valid number (7-20 digits, optional +)", 400, "VALIDATION_ERROR");
  }
  if (password.length < 8) {
    throw new AppError("password must be at least 8 characters", 400, "VALIDATION_ERROR");
  }
  return { firstName: first, lastName: last, phone, email, password };
}

export async function signUp(request: Request, response: Response): Promise<void> {
  const { firstName, lastName, phone, email, password } = validateCredentials(request.body);
  const name = [firstName, lastName].filter(Boolean).join(" ");
  const requestedRole = (request.body as Record<string, unknown> | undefined)?.role;
  if (requestedRole === "admin") {
    throw new AppError("Public signup cannot create an admin account", 403, "ADMIN_SIGNUP_FORBIDDEN");
  }
  if (requestedRole !== undefined && requestedRole !== "student" && requestedRole !== "instructor") {
    throw new AppError("role must be student or instructor", 400, "VALIDATION_ERROR");
  }
  const role = (requestedRole ?? "student") as "student" | "instructor";
  const status: UserStatus = role === "instructor" ? "pending" : "active";

  const [existingUsers] = await database.execute<RowDataPacket[]>(
    "SELECT id FROM users WHERE email = ? LIMIT 1",
    [email],
  );
  if (existingUsers.length > 0) {
    throw new AppError("Email is already registered", 409, "EMAIL_EXISTS");
  }

  const passwordHash = await hash(password, 12);
  const [result] = await database.execute<ResultSetHeader>(
    "INSERT INTO users (name, first_name, last_name, phone, email, password_hash, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [name, firstName, lastName || null, phone, email, passwordHash, role, status],
  );
  sendSuccess(response, { id: result.insertId, name, firstName, lastName, phone, email, role, status }, 201, "Account created");
}

export async function login(request: Request, response: Response): Promise<void> {
  const value = (request.body ?? {}) as Record<string, unknown>;
  const email = typeof value.email === "string" ? value.email.trim().toLowerCase() : "";
  const password = typeof value.password === "string" ? value.password : "";
  if (!email || !password) {
    throw new AppError("email and password are required", 400, "VALIDATION_ERROR");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AppError("email must be valid", 400, "VALIDATION_ERROR");
  }

  const [users] = await database.execute<UserRow[]>(
    "SELECT id, name, first_name, last_name, phone, email, password_hash, role, status FROM users WHERE email = ? LIMIT 1",
    [email],
  );
  const user = users[0];
  if (!user?.password_hash || !(await compare(password, user.password_hash))) {
    throw new AppError("Invalid email or password", 401, "INVALID_CREDENTIALS");
  }
  if (user.status === "suspended") {
    throw new AppError("Your account has been suspended", 403, "ACCOUNT_SUSPENDED");
  }

  // Create token pair with refresh token rotation
  const userAgent = request.headers["user-agent"];
  const ip = request.ip;
  const tokens = await createTokenPair(user.id, user.role, userAgent, ip);

  // Set HttpOnly cookies
  setAuthCookies(response, tokens.accessToken, tokens.refreshToken);

  logger.info({ userId: user.id, role: user.role }, "User logged in");

  sendSuccess(response, { user: publicUser(user) }, 200, "Logged in successfully");
}

export async function logout(request: Request, response: Response): Promise<void> {
  // Get refresh token from cookie
  const refreshToken = request.cookies?.refresh_token;
  if (refreshToken) {
    const tokenHash = hashToken(refreshToken);
    await revokeRefreshToken(tokenHash);
  }

  // Also revoke access token if present
  const accessToken = request.cookies?.access_token;
  if (accessToken) {
    await revokeAccessToken(accessToken);
  }

  // Clear cookies
  clearAuthCookies(response);

  if (request.user) {
    logger.info({ userId: request.user.id }, "User logged out");
  }

  sendSuccess(response, null, 200, "Logged out successfully");
}

export async function refresh(request: Request, response: Response): Promise<void> {
  const refreshToken = request.cookies?.refresh_token;
  if (!refreshToken) {
    throw new AppError("Refresh token is required", 401, "REFRESH_TOKEN_REQUIRED");
  }

  const userAgent = request.headers["user-agent"];
  const ip = request.ip;

  const tokens = await rotateRefreshToken(refreshToken, userAgent, ip);

  // Set new HttpOnly cookies
  setAuthCookies(response, tokens.accessToken, tokens.refreshToken);

  sendSuccess(response, { user: request.user ?? null }, 200, "Token refreshed successfully");
}

export function getCurrentUser(request: Request, response: Response): void {
  if (!request.user) {
    throw new AppError("Authentication token is required", 401, "UNAUTHORIZED");
  }

  sendSuccess(response, { user: request.user });
}

export async function updateProfile(request: Request, response: Response): Promise<void> {
    if (!request.user) throw new AppError("Authentication token is required", 401, "UNAUTHORIZED");
    const body = (request.body ?? {}) as Record<string, unknown>;
    const [currentRows] = await database.execute<UserRow[]>(
      "SELECT id, name, first_name, last_name, phone, email, role, status, created_at, updated_at FROM users WHERE id = ?",
      [request.user.id],
    );
    const current = currentRows[0];
    if (!current) throw new AppError("User not found", 404, "NOT_FOUND");

    const text = (input: unknown) => (typeof input === "string" ? input.trim() : undefined);
    const email = body.email === undefined ? undefined : text(body.email) ?? "";
    if (email === "") throw new AppError("email cannot be empty", 400, "VALIDATION_ERROR");
    if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError("email must be valid", 400, "VALIDATION_ERROR");
    if (email !== undefined) {
      const [existing] = await database.execute<RowDataPacket[]>("SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1", [email, request.user.id]);
      if (existing[0]) throw new AppError("Email is already registered", 409, "EMAIL_EXISTS");
    }

    // Resolve first/last name (falling back to current values), then keep the
    // derived full name in sync.
    let firstName = body.firstName === undefined ? (current.first_name ?? "") : text(body.firstName) ?? "";
    let lastName = body.lastName === undefined ? (current.last_name ?? "") : text(body.lastName) ?? "";
    const explicitName = body.name === undefined ? undefined : text(body.name) ?? "";
    if (explicitName === "") throw new AppError("name cannot be empty", 400, "VALIDATION_ERROR");
    if (explicitName && body.firstName === undefined && body.lastName === undefined) {
      const parts = explicitName.split(/\s+/).filter(Boolean);
      firstName = parts[0] ?? "";
      lastName = parts.slice(1).join(" ");
    }
    if (!firstName) throw new AppError("firstName cannot be empty", 400, "VALIDATION_ERROR");
    const name = [firstName, lastName].filter(Boolean).join(" ");

    let phone: string | null = body.phone === undefined ? (current.phone ?? null) : (text(body.phone) || null);
    if (phone && !PHONE_PATTERN.test(phone)) throw new AppError("phone must be a valid number (7-20 digits, optional +)", 400, "VALIDATION_ERROR");

    const touched =
      name !== current.name ||
      firstName !== (current.first_name ?? "") ||
      lastName !== (current.last_name ?? "") ||
      phone !== current.phone ||
      email !== undefined;
    if (!touched) throw new AppError("At least one field is required", 400, "VALIDATION_ERROR");

    await database.execute(
      "UPDATE users SET name = ?, first_name = ?, last_name = ?, phone = ?, email = COALESCE(?, email) WHERE id = ?",
      [name, firstName, lastName || null, phone, email ?? null, request.user.id],
    );
    const [users] = await database.execute<UserRow[]>(
      "SELECT id, name, first_name, last_name, phone, email, role, status, created_at, updated_at FROM users WHERE id = ?",
      [request.user.id],
    );
    sendSuccess(response, publicUser(users[0]), 200, "Profile updated");
}

export async function listUsers(request: Request, response: Response): Promise<void> {
  const isInstructor = request.user?.role === "instructor";
  const query = isInstructor
    ? `SELECT DISTINCT u.id, u.name, u.first_name, u.last_name, u.phone, u.email, u.role, u.status, u.created_at, u.updated_at,
         COUNT(DISTINCT e.course_id) course_count, MIN(e.enrolled_at) joined_at
       FROM users u
       JOIN enrollments e ON e.user_id = u.id
       JOIN courses c ON c.id = e.course_id
       WHERE c.instructor_id = ? AND u.role = 'student'
       GROUP BY u.id, u.name, u.first_name, u.last_name, u.phone, u.email, u.role, u.status, u.created_at, u.updated_at
       ORDER BY u.created_at DESC`
    : `SELECT u.id, u.name, u.first_name, u.last_name, u.phone, u.email, u.role, u.status, u.created_at, u.updated_at,
         (SELECT COUNT(DISTINCT e.course_id) FROM enrollments e WHERE e.user_id = u.id) course_count,
         (SELECT MIN(e.enrolled_at) FROM enrollments e WHERE e.user_id = u.id) joined_at
       FROM users u ORDER BY u.created_at DESC`;
  const [users] = await database.execute<UserRow[]>(
    query,
    isInstructor ? [request.user?.id ?? 0] : [],
  );
  sendSuccess(response, users.map(publicUser));
}

export async function getUser(request: Request, response: Response): Promise<void> {
  const id = parsePositiveId(request.params.id);
  const isInstructor = request.user?.role === "instructor";
  const query = isInstructor
    ? `SELECT DISTINCT u.id, u.name, u.first_name, u.last_name, u.phone, u.email, u.role, u.status, u.created_at, u.updated_at
       FROM users u
       JOIN enrollments e ON e.user_id = u.id
       JOIN courses c ON c.id = e.course_id
       WHERE u.id = ? AND c.instructor_id = ? AND u.role = 'student'
       LIMIT 1`
    : `SELECT id, name, first_name, last_name, phone, email, role, status, created_at, updated_at
       FROM users WHERE id = ? LIMIT 1`;
  const [users] = await database.execute<UserRow[]>(
    query,
    isInstructor ? [id, request.user?.id ?? 0] : [id],
  );
  if (!users[0]) {
    throw new AppError("User not found", 404, "NOT_FOUND");
  }
  sendSuccess(response, publicUser(users[0]));
}

export async function updateUserStatus(request: Request, response: Response): Promise<void> {
  const id = parsePositiveId(request.params.id, "user id");
  const status = String((request.body as Record<string, unknown> | undefined)?.status ?? "");
  if (!(["active", "pending", "suspended"] as string[]).includes(status)) {
    throw new AppError("status must be active, pending, or suspended", 400, "VALIDATION_ERROR");
  }
  const [existing] = await database.execute<UserRow[]>(
    "SELECT id, role, status FROM users WHERE id = ? LIMIT 1",
    [id],
  );
  if (!existing[0]) {
    throw new AppError("User not found", 404, "NOT_FOUND");
  }
  if (Number(id) === request.user?.id && status !== "active") {
    throw new AppError("You cannot suspend your own account", 400, "SELF_STATUS_CHANGE");
  }
  // An unchanged status is not a 404 — still return the current user.
  if (existing[0].status !== status) {
    await database.execute<ResultSetHeader>(
      "UPDATE users SET status = ? WHERE id = ?",
      [status, id],
    );
    // Suspended users must not keep live sessions
    if (status === "suspended") {
      await revokeAllUserTokens(id);
    }
    // Tell the user when their account is approved or suspended.
    if (status === "active" && existing[0].status === "pending") {
      await notify(id, "account", "Your account has been approved",
        "Your Nexora account is now active. You can access the full workspace.", "/dashboard");
    } else if (status === "suspended") {
      await notify(id, "account", "Your account has been suspended",
        "An administrator has suspended your account. Contact support for details.", null);
    }
  }
  const [users] = await database.execute<UserRow[]>(
    "SELECT id, name, email, role, status, created_at, updated_at FROM users WHERE id = ?",
    [id],
  );
  logger.info({ actorId: request.user?.id, userId: id, status }, "User status updated");
  sendSuccess(response, publicUser(users[0]), 200, "User status updated");
}
