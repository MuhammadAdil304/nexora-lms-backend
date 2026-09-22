import { Request, Response } from "express";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import { database } from "../config/database";
import { AppError, parsePositiveId, sendSuccess } from "../utils/http";

interface LessonRow extends RowDataPacket {
  id: number;
  course_id: number;
  module_id?: number | null;
  title: string;
  content: string | null;
  position: number;
  content_type?: "text" | "video" | "article";
  video_url?: string | null;
  duration_minutes?: number | null;
  created_at: Date;
  updated_at: Date;
  locked?: boolean;
}

const LESSON_CONTENT_TYPES = ["text", "video", "article"] as const;

function normalizeVideoUrl(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return value === null ? null : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 500 || !/^https?:\/\//i.test(trimmed)) {
    throw new AppError("videoUrl must be a valid http(s) URL (max 500 characters)", 400, "VALIDATION_ERROR");
  }
  return trimmed;
}

function normalizeDuration(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  const duration = typeof value === "number" ? Math.floor(value) : NaN;
  if (!Number.isSafeInteger(duration) || duration < 0 || duration > 10000) {
    throw new AppError("durationMinutes must be an integer between 0 and 10000", 400, "VALIDATION_ERROR");
  }
  return duration;
}

function mapLesson(lesson: LessonRow) {
  return {
    id: Number(lesson.id),
    courseId: Number(lesson.course_id),
    moduleId: lesson.module_id === null || lesson.module_id === undefined ? null : Number(lesson.module_id),
    title: lesson.title,
    content: lesson.content,
    position: Number(lesson.position),
    contentType: lesson.content_type ?? "text",
    videoUrl: lesson.video_url ?? null,
    durationMinutes: lesson.duration_minutes === null || lesson.duration_minutes === undefined
      ? null : Number(lesson.duration_minutes),
    locked: Boolean(lesson.locked),
    createdAt: lesson.created_at,
    updatedAt: lesson.updated_at,
  };
}

async function canAccessCourseContent(request: Request, courseId: number, instructorId: number): Promise<boolean> {
  if (request.user?.role === "admin" || request.user?.id === instructorId) return true;
  if (!request.user || request.user.role !== "student") return false;
  const [rows] = await database.execute<RowDataPacket[]>(
    "SELECT id FROM enrollments WHERE course_id = ? AND user_id = ? LIMIT 1",
    [courseId, request.user.id],
  );
  return Boolean(rows[0]);
}

async function assertCourseOwner(request: Request, courseId: number): Promise<void> {
  const [rows] = await database.execute<RowDataPacket[]>(
    "SELECT instructor_id FROM courses WHERE id = ? LIMIT 1", [courseId],
  );
  if (!rows[0]) throw new AppError("Course not found", 404, "NOT_FOUND");
  if (request.user?.role !== "admin" && Number(rows[0].instructor_id) !== request.user?.id) {
    throw new AppError("You do not own this course", 403, "FORBIDDEN");
  }
}

async function assertLessonAccess(request: Request, lessonId: number): Promise<LessonRow> {
  const [rows] = await database.execute<LessonRow[]>(
    `SELECT l.*, c.instructor_id, c.status FROM lessons l JOIN courses c ON c.id = l.course_id
     WHERE l.id = ? LIMIT 1`,
    [lessonId],
  );
  const lesson = rows[0];
  if (!lesson) throw new AppError("Lesson not found", 404, "NOT_FOUND");
  const isPublicCourse = lesson.status === "published";
  const hasContentAccess = await canAccessCourseContent(request, Number(lesson.course_id), Number(lesson.instructor_id));
  if (!isPublicCourse && !hasContentAccess) throw new AppError("Lesson not found", 404, "NOT_FOUND");
  if (!hasContentAccess) throw new AppError("Enroll in the course to view this lesson", 403, "ENROLLMENT_REQUIRED");
  return lesson;
}

export async function listLessons(request: Request, response: Response): Promise<void> {
  const courseId = parsePositiveId(request.params.courseId, "course id");
  const [courses] = await database.execute<RowDataPacket[]>(
    "SELECT id, status, instructor_id FROM courses WHERE id = ? LIMIT 1", [courseId],
  );
  const course = courses[0];
  if (!course) throw new AppError("Course not found", 404, "NOT_FOUND");
  if (course.status !== "published" &&
      request.user?.id !== Number(course.instructor_id) &&
      request.user?.role !== "admin") {
    throw new AppError("Course not found", 404, "NOT_FOUND");
  }
  const hasContentAccess = await canAccessCourseContent(request, courseId, Number(course.instructor_id));
  const [lessons] = await database.execute<LessonRow[]>(
    "SELECT * FROM lessons WHERE course_id = ? ORDER BY position ASC, id ASC", [courseId],
  );
  sendSuccess(response, lessons.map((lesson) => mapLesson({
    ...lesson,
    content: hasContentAccess ? lesson.content : null,
    locked: !hasContentAccess,
  })));
}

export async function getLesson(request: Request, response: Response): Promise<void> {
  const lesson = await assertLessonAccess(request, parsePositiveId(request.params.id, "lesson id"));
  sendSuccess(response, mapLesson(lesson));
}

export async function createLesson(request: Request, response: Response): Promise<void> {
  const courseId = parsePositiveId(request.params.courseId, "course id");
  await assertCourseOwner(request, courseId);
  const body = (request.body ?? {}) as Record<string, unknown>;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const content = body.content === null ? null : typeof body.content === "string" ? body.content : undefined;
  if (!title) throw new AppError("title is required", 400, "VALIDATION_ERROR");
  if (content === undefined) throw new AppError("content must be a string or null", 400, "VALIDATION_ERROR");
  let position = typeof body.position === "number" ? Math.floor(body.position) : 0;
  const contentType = body.contentType === undefined ? "text"
    : LESSON_CONTENT_TYPES.includes(body.contentType as typeof LESSON_CONTENT_TYPES[number])
      ? String(body.contentType)
      : (() => { throw new AppError("contentType must be text, video, or article", 400, "VALIDATION_ERROR"); })();
  const videoUrl = normalizeVideoUrl(body.videoUrl) ?? null;
  const durationMinutes = normalizeDuration(body.durationMinutes) ?? null;

  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const [countRows] = await connection.execute<RowDataPacket[]>(
      "SELECT COUNT(*) count FROM lessons WHERE course_id = ?", [courseId],
    );
    const count = Number(countRows[0].count);
    if (!position || position < 1 || position > count + 1) position = count + 1;
    await connection.execute(
      "UPDATE lessons SET position = position + 1 WHERE course_id = ? AND position >= ?",
      [courseId, position],
    );
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO lessons (course_id, title, content, position, content_type, video_url, duration_minutes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [courseId, title, content ?? null, position, contentType, videoUrl, durationMinutes],
    );
    await connection.commit();
    const [lessons] = await database.execute<LessonRow[]>("SELECT * FROM lessons WHERE id = ?", [result.insertId]);
    sendSuccess(response, mapLesson(lessons[0]), 201, "Lesson created");
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function updateLesson(request: Request, response: Response): Promise<void> {
  const lessonId = parsePositiveId(request.params.id, "lesson id");
  const lesson = await assertLessonAccess({ ...request, user: request.user } as Request, lessonId);
  await assertCourseOwner(request, Number(lesson.course_id));
  const body = (request.body ?? {}) as Record<string, unknown>;
  const title = body.title === undefined ? undefined : typeof body.title === "string" ? body.title.trim() : "";
  const content = body.content === undefined
    ? undefined
    : body.content === null ? null : typeof body.content === "string" ? body.content : undefined;
  if (title === "") throw new AppError("title cannot be empty", 400, "VALIDATION_ERROR");
  if (body.content !== undefined && content === undefined) {
    throw new AppError("content must be a string or null", 400, "VALIDATION_ERROR");
  }
  const requestedPosition = body.position === undefined ? undefined :
    typeof body.position === "number" ? Math.floor(body.position) : NaN;
  if (requestedPosition !== undefined && (!Number.isSafeInteger(requestedPosition) || requestedPosition < 1)) {
    throw new AppError("position must be a positive integer", 400, "VALIDATION_ERROR");
  }

  const updates: string[] = [];
  const values: Array<string | number | null> = [];
  if (title !== undefined) { updates.push("title = ?"); values.push(title); }
  if (content !== undefined) { updates.push("content = ?"); values.push(content); }
  if (body.contentType !== undefined) {
    if (!LESSON_CONTENT_TYPES.includes(body.contentType as typeof LESSON_CONTENT_TYPES[number])) {
      throw new AppError("contentType must be text, video, or article", 400, "VALIDATION_ERROR");
    }
    updates.push("content_type = ?"); values.push(String(body.contentType));
  }
  if (body.videoUrl !== undefined) { updates.push("video_url = ?"); values.push(normalizeVideoUrl(body.videoUrl) ?? null); }
  if (body.durationMinutes !== undefined) { updates.push("duration_minutes = ?"); values.push(normalizeDuration(body.durationMinutes) ?? null); }
  if (updates.length) {
    values.push(lessonId);
    await database.execute(`UPDATE lessons SET ${updates.join(", ")} WHERE id = ?`, values);
  }
  if (requestedPosition !== undefined && requestedPosition !== Number(lesson.position)) {
    await moveLesson(Number(lesson.course_id), lessonId, requestedPosition);
  }
  const [lessons] = await database.execute<LessonRow[]>("SELECT * FROM lessons WHERE id = ?", [lessonId]);
  sendSuccess(response, mapLesson(lessons[0]));
}

async function moveLesson(courseId: number, lessonId: number, requestedPosition: number): Promise<void> {
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<LessonRow[]>(
      "SELECT id, position FROM lessons WHERE course_id = ? ORDER BY position, id", [courseId],
    );
    const currentIndex = rows.findIndex((row) => Number(row.id) === lessonId);
    if (currentIndex < 0) throw new AppError("Lesson not found", 404, "NOT_FOUND");
    const targetIndex = Math.min(requestedPosition - 1, rows.length - 1);
    const ordered = rows.slice();
    const [moving] = ordered.splice(currentIndex, 1);
    ordered.splice(targetIndex, 0, moving);
    await connection.execute("UPDATE lessons SET position = position + 1000000 WHERE course_id = ?", [courseId]);
    for (let index = 0; index < ordered.length; index += 1) {
      await connection.execute("UPDATE lessons SET position = ? WHERE id = ?", [index + 1, ordered[index].id]);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function deleteLesson(request: Request, response: Response): Promise<void> {
  const lessonId = parsePositiveId(request.params.id, "lesson id");
  const lesson = await assertLessonAccess(request, lessonId);
  await assertCourseOwner(request, Number(lesson.course_id));
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute("DELETE FROM lessons WHERE id = ?", [lessonId]);
    await connection.execute(
      "UPDATE lessons SET position = position - 1 WHERE course_id = ? AND position > ?",
      [lesson.course_id, lesson.position],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  sendSuccess(response, null, 200, "Lesson deleted");
}

export async function reorderLessons(request: Request, response: Response): Promise<void> {
  const courseId = parsePositiveId(request.params.courseId, "course id");
  await assertCourseOwner(request, courseId);
  const body = (request.body ?? {}) as Record<string, unknown>;
  const order = body.lessonIds;
  if (!Array.isArray(order) || order.some((id) => !Number.isSafeInteger(Number(id)))) {
    throw new AppError("lessonIds must be an array of ids", 400, "VALIDATION_ERROR");
  }
  const ids = order.map(Number);
  const [lessons] = await database.execute<LessonRow[]>(
    "SELECT id FROM lessons WHERE course_id = ?", [courseId],
  );
  const existing = lessons.map((lesson) => Number(lesson.id)).sort((a, b) => a - b);
  if (ids.length !== existing.length || ids.slice().sort((a, b) => a - b).join(",") !== existing.join(",")) {
    throw new AppError("lessonIds must contain every lesson in the course exactly once", 400, "VALIDATION_ERROR");
  }
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute("UPDATE lessons SET position = position + 1000000 WHERE course_id = ?", [courseId]);
    for (let index = 0; index < ids.length; index += 1) {
      await connection.execute("UPDATE lessons SET position = ? WHERE id = ?", [index + 1, ids[index]]);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  const [updated] = await database.execute<LessonRow[]>(
    "SELECT * FROM lessons WHERE course_id = ? ORDER BY position", [courseId],
  );
  sendSuccess(response, updated.map(mapLesson), 200, "Lessons reordered");
}
