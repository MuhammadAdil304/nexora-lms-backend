import { Request, Response } from "express";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import { database } from "../config/database";
import { AppError, parsePositiveId, sendSuccess } from "../utils/http";
import { notifyCourseStudents } from "../utils/notifications";

interface CourseRow extends RowDataPacket {
  id: number;
  instructor_id: number;
  category_id?: number | null;
  title: string;
  description: string | null;
  status: "draft" | "published" | "archived";
  level: "beginner" | "intermediate" | "advanced";
  duration?: string | null;
  learning_outcomes?: string | null;
  thumbnail_url?: string | null;
  created_at: Date;
  updated_at: Date;
  instructor_name?: string;
  student_count?: number;
  rating_average?: number | null;
  rating_count?: number;
  lesson_count?: number;
}

/** Catalog aggregates (student counts, ratings, lesson totals) for course cards. */
const COURSE_AGGREGATES = `
  (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id) AS student_count,
  (SELECT ROUND(AVG(r.rating), 1) FROM course_reviews r WHERE r.course_id = c.id) AS rating_average,
  (SELECT COUNT(*) FROM course_reviews r WHERE r.course_id = c.id) AS rating_count,
  (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id) AS lesson_count`;

function mapCourse(course: CourseRow) {
  return {
    id: Number(course.id),
    instructorId: Number(course.instructor_id),
    instructorName: course.instructor_name,
    categoryId: course.category_id === null || course.category_id === undefined ? undefined : Number(course.category_id),
    title: course.title,
    description: course.description,
    status: course.status,
    level: course.level,
    duration: course.duration,
    learningOutcomes: course.learning_outcomes
      ? course.learning_outcomes.split("\n").map((item) => item.trim()).filter(Boolean)
      : [],
    thumbnailUrl: course.thumbnail_url,
    studentCount: course.student_count === undefined ? undefined : Number(course.student_count),
    ratingAverage: course.rating_average === null || course.rating_average === undefined
      ? null : Number(course.rating_average),
    ratingCount: course.rating_count === undefined ? undefined : Number(course.rating_count),
    lessonCount: course.lesson_count === undefined ? undefined : Number(course.lesson_count),
    createdAt: course.created_at,
    updatedAt: course.updated_at,
  };
}

function bodyFields(request: Request) {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const title = typeof body.title === "string" ? body.title.trim() : undefined;
  const description = body.description === null
    ? null
    : typeof body.description === "string" ? body.description.trim() : undefined;
  const status = body.status;
  const level = body.level;
  const duration = body.duration === null
    ? null
    : typeof body.duration === "string" ? body.duration.trim() : undefined;
  const learningOutcomes = body.learningOutcomes === null
    ? null
    : Array.isArray(body.learningOutcomes)
      ? body.learningOutcomes.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).join("\n")
      : typeof body.learningOutcomes === "string" ? body.learningOutcomes.trim() : undefined;
  const thumbnailUrl = body.thumbnailUrl === null
    ? null
    : typeof body.thumbnailUrl === "string" ? body.thumbnailUrl.trim() : undefined;
  if (title !== undefined && !title) {
    throw new AppError("title cannot be empty", 400, "VALIDATION_ERROR");
  }
  if (status !== undefined && !["draft", "published", "archived"].includes(String(status))) {
    throw new AppError("status must be draft, published, or archived", 400, "VALIDATION_ERROR");
  }
  if (level !== undefined && !["beginner", "intermediate", "advanced"].includes(String(level))) {
    throw new AppError("level must be beginner, intermediate, or advanced", 400, "VALIDATION_ERROR");
  }
  const categoryId = body.categoryId === undefined || body.categoryId === null ? body.categoryId : typeof body.categoryId === "number" ? body.categoryId : NaN;
  if (categoryId !== undefined && categoryId !== null && (!Number.isSafeInteger(categoryId) || categoryId <= 0)) throw new AppError("categoryId must be a positive integer", 400, "VALIDATION_ERROR");
  return {
    title,
    description,
    status: status as CourseRow["status"] | undefined,
    categoryId: categoryId as number | null | undefined,
    level: level as CourseRow["level"] | undefined,
    duration,
    learningOutcomes,
    thumbnailUrl,
  };
}

export async function listCourses(
  request: Request,
  response: Response
): Promise<void> {
  const role = request.user?.role;
  const userId = request.user?.id;

  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (role === "admin") {
    // Admin: all courses, regardless of status
  } else if (role === "instructor") {
    // Instructor: only own courses, including drafts
    conditions.push("c.instructor_id = ?");
    params.push(userId ?? 0);
  } else {
    // Student/other users: only published courses
    conditions.push("c.status = 'published'");
  }

  // Optional catalog filters from the query string.
  const search = typeof request.query.search === "string" ? request.query.search.trim().slice(0, 100) : "";
  if (search) {
    conditions.push("(c.title LIKE ? OR c.description LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }
  const level = typeof request.query.level === "string" ? request.query.level : "";
  if (["beginner", "intermediate", "advanced"].includes(level)) {
    conditions.push("c.level = ?");
    params.push(level);
  }
  if (request.query.categoryId !== undefined) {
    conditions.push("c.category_id = ?");
    params.push(parsePositiveId(String(request.query.categoryId), "category id"));
  }

  const limit = request.query.limit === undefined ? undefined
    : Math.min(Math.max(Number(request.query.limit) || 0, 1), 100) | 0;
  const offset = limit === undefined ? 0
    : Math.max((Math.max(Number(request.query.page ?? 1) || 1, 1) - 1) * limit, 0) | 0;

  // LIMIT/OFFSET are interpolated as validated integers because TiDB's
  // prepared-statement protocol rejects bound parameters for these clauses.
  const query = `
    SELECT c.*, u.name AS instructor_name, ${COURSE_AGGREGATES}
    FROM courses c
    JOIN users u ON u.id = c.instructor_id
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
    ORDER BY c.created_at DESC
    ${limit !== undefined ? `LIMIT ${limit} OFFSET ${offset}` : ""}
  `;
  const [courses] = await database.execute<CourseRow[]>(query, params);

  if (limit !== undefined) {
    // Paginated envelope when the caller asks for pages of results.
    const [countRows] = await database.execute<RowDataPacket[]>(
      `SELECT COUNT(*) total FROM courses c ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}`,
      params,
    );
    const total = Number(countRows[0]?.total ?? 0);
    sendSuccess(response, {
      courses: courses.map(mapCourse),
      total,
      limit,
      offset,
      totalPages: Math.ceil(total / limit) || 1,
    });
    return;
  }
  sendSuccess(response, courses.map(mapCourse));
}

export async function getCourse(request: Request, response: Response): Promise<void> {
  const id = parsePositiveId(request.params.id, "course id");
  const [courses] = await database.execute<CourseRow[]>(
    `SELECT c.*, u.name instructor_name, ${COURSE_AGGREGATES}
     FROM courses c
     JOIN users u ON u.id = c.instructor_id WHERE c.id = ? LIMIT 1`,
    [id],
  );
  const course = courses[0];
  if (!course || (course.status !== "published" &&
    request.user?.id !== Number(course.instructor_id) &&
    request.user?.role !== "admin")) {
    throw new AppError("Course not found", 404, "NOT_FOUND");
  }
  sendSuccess(response, mapCourse(course));
}

export async function createCourse(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Authentication token is required", 401, "UNAUTHORIZED");
  const { title, description, status, categoryId, level, duration, learningOutcomes, thumbnailUrl } = bodyFields(request);
  if (!title) throw new AppError("title is required", 400, "VALIDATION_ERROR");
  const instructorId = request.user.role === "admin" &&
    typeof (request.body as Record<string, unknown>)?.instructorId === "number"
    ? Number((request.body as Record<string, unknown>).instructorId)
    : request.user.id;
  const [result] = await database.execute<ResultSetHeader>(
    "INSERT INTO courses (instructor_id, category_id, title, description, status, level, duration, learning_outcomes, thumbnail_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [instructorId, categoryId ?? null, title, description ?? null, status ?? "draft", level ?? "beginner", duration ?? null, learningOutcomes ?? null, thumbnailUrl ?? null],
  );
  const [courses] = await database.execute<CourseRow[]>(
    `SELECT c.*, u.name instructor_name FROM courses c JOIN users u ON u.id = c.instructor_id WHERE c.id = ?`,
    [result.insertId],
  );
  sendSuccess(response, mapCourse(courses[0]), 201, "Course created");
}

async function findOwnedCourse(request: Request) {
  const id = parsePositiveId(request.params.id, "course id");
  const [courses] = await database.execute<CourseRow[]>(
    "SELECT * FROM courses WHERE id = ? LIMIT 1", [id],
  );
  const course = courses[0];
  if (!course) throw new AppError("Course not found", 404, "NOT_FOUND");
  if (request.user?.role !== "admin" && Number(course.instructor_id) !== request.user?.id) {
    throw new AppError("You do not own this course", 403, "FORBIDDEN");
  }
  return course;
}

export async function updateCourse(request: Request, response: Response): Promise<void> {
  const existing = await findOwnedCourse(request);
  const { title, description, status, categoryId, level, duration, learningOutcomes, thumbnailUrl } = bodyFields(request);
  if (title === undefined && description === undefined && status === undefined && categoryId === undefined && level === undefined && duration === undefined && learningOutcomes === undefined && thumbnailUrl === undefined) {
    throw new AppError("At least one field is required", 400, "VALIDATION_ERROR");
  }
  const id = parsePositiveId(request.params.id, "course id");
  const updates: string[] = [];
  const values: Array<string | number | null> = [];
  if (title !== undefined) { updates.push("title = ?"); values.push(title); }
  if (description !== undefined) { updates.push("description = ?"); values.push(description); }
  if (status !== undefined) { updates.push("status = ?"); values.push(status); }
  if (categoryId !== undefined) { updates.push("category_id = ?"); values.push(categoryId); }
  if (level !== undefined) { updates.push("level = ?"); values.push(level); }
  if (duration !== undefined) { updates.push("duration = ?"); values.push(duration); }
  if (learningOutcomes !== undefined) { updates.push("learning_outcomes = ?"); values.push(learningOutcomes); }
  if (thumbnailUrl !== undefined) { updates.push("thumbnail_url = ?"); values.push(thumbnailUrl); }
  values.push(id);
  await database.execute(`UPDATE courses SET ${updates.join(", ")} WHERE id = ?`, values);
  // Tell enrolled students the moment their course goes live.
  if (status === "published" && existing.status !== "published") {
    await notifyCourseStudents(id, "system", "A course you enrolled in is now live",
      `"${title ?? existing.title}" has been published. Start learning now!`,
      `/courses/${id}`);
  }
  await getCourse(request, response);
}

export async function deleteCourse(request: Request, response: Response): Promise<void> {
  await findOwnedCourse(request);
  const id = parsePositiveId(request.params.id, "course id");
  await database.execute("DELETE FROM courses WHERE id = ?", [id]);
  sendSuccess(response, null, 200, "Course deleted");
}
