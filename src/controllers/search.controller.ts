import { Request, Response } from "express";
import { RowDataPacket } from "mysql2";
import { database } from "../config/database";
import { AppError, sendSuccess } from "../utils/http";

interface CourseHit extends RowDataPacket {
  id: number;
  title: string;
  status: string;
  instructor_name: string;
}

interface UserHit extends RowDataPacket {
  id: number;
  name: string;
  email: string;
  role: string;
  status: string;
}

/** Global workspace search (navbar search box in the design). */
export async function globalSearch(request: Request, response: Response): Promise<void> {
  const query = String(request.query.q ?? "").trim();
  if (!query) throw new AppError("q query parameter is required", 400, "VALIDATION_ERROR");
  const pattern = `%${query.slice(0, 100)}%`;
  const role = request.user?.role;
  const userId = request.user?.id ?? 0;

  // Students only see published courses; staff also see their own drafts.
  const courseVisibility = role === "admin"
    ? ""
    : role === "instructor"
      ? "AND (c.status = 'published' OR c.instructor_id = ?)"
      : "AND c.status = 'published'";
  const courseParams: Array<string | number> = role === "instructor"
    ? [pattern, pattern, userId]
    : [pattern, pattern];
  const [courses] = await database.execute<CourseHit[]>(
    `SELECT c.id, c.title, c.status, u.name instructor_name
     FROM courses c JOIN users u ON u.id = c.instructor_id
     WHERE (c.title LIKE ? OR c.description LIKE ?) ${courseVisibility}
     ORDER BY c.title LIMIT 10`,
    courseParams,
  );

  const results: Record<string, unknown> = {
    courses: courses.map((course) => ({
      id: Number(course.id),
      title: course.title,
      status: course.status,
      instructorName: course.instructor_name,
    })),
  };

  // Staff users can additionally search people.
  if (role === "admin") {
    const [users] = await database.execute<UserHit[]>(
      `SELECT id, name, email, role, status FROM users
       WHERE name LIKE ? OR email LIKE ? ORDER BY name LIMIT 10`,
      [pattern, pattern],
    );
    results.users = users.map((user) => ({
      id: Number(user.id),
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
    }));
  } else if (role === "instructor") {
    const [users] = await database.execute<UserHit[]>(
      `SELECT DISTINCT u.id, u.name, u.email, u.role, u.status
       FROM users u
       JOIN enrollments e ON e.user_id = u.id
       JOIN courses c ON c.id = e.course_id
       WHERE c.instructor_id = ? AND (u.name LIKE ? OR u.email LIKE ?)
       ORDER BY u.name LIMIT 10`,
      [userId, pattern, pattern],
    );
    results.users = users.map((user) => ({
      id: Number(user.id),
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
    }));
  }

  sendSuccess(response, results);
}
