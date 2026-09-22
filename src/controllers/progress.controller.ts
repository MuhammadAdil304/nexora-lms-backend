import { Request, Response } from "express";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import crypto from "crypto";
import { database } from "../config/database";
import { AppError, parsePositiveId, sendSuccess } from "../utils/http";
import { notify } from "../utils/notifications";

interface ProgressRow extends RowDataPacket {
  lesson_id: number;
  lesson_title: string;
  position: number;
  completed_at: Date | null;
}

interface EnrollmentInfo extends RowDataPacket {
  id: number;
  user_id: number;
  course_id: number;
  instructor_id: number;
}

async function getEnrollment(request: Request): Promise<EnrollmentInfo> {
  const enrollmentId = parsePositiveId(request.params.enrollmentId, "enrollment id");
  const [rows] = await database.execute<EnrollmentInfo[]>(
    `SELECT e.id, e.user_id, e.course_id, c.instructor_id
     FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.id = ? LIMIT 1`,
    [enrollmentId],
  );
  const enrollment = rows[0];
  if (!enrollment) throw new AppError("Enrollment not found", 404, "NOT_FOUND");
  const allowed = request.user?.role === "admin" ||
    Number(enrollment.user_id) === request.user?.id ||
    Number(enrollment.instructor_id) === request.user?.id;
  if (!allowed) throw new AppError("You do not have access to this progress", 403, "FORBIDDEN");
  return enrollment;
}

async function progressData(enrollment: EnrollmentInfo) {
  const [rows] = await database.execute<ProgressRow[]>(
    `SELECT l.id lesson_id, l.title lesson_title, l.position, ep.completed_at
     FROM lessons l
     LEFT JOIN enrollment_progress ep
       ON ep.lesson_id = l.id AND ep.enrollment_id = ?
     WHERE l.course_id = ? ORDER BY l.position, l.id`,
    [enrollment.id, enrollment.course_id],
  );
  const total = rows.length;
  const completed = rows.filter((row) => row.completed_at !== null).length;
  return {
    enrollmentId: Number(enrollment.id),
    courseId: Number(enrollment.course_id),
    totalLessons: total,
    completedLessons: completed,
    percentage: total === 0 ? 0 : Math.round((completed / total) * 100),
    completed: total > 0 && completed === total,
    lessons: rows.map((row) => ({
      lessonId: Number(row.lesson_id),
      title: row.lesson_title,
      position: Number(row.position),
      completed: row.completed_at !== null,
      completedAt: row.completed_at,
    })),
  };
}

/** Issue a certificate (idempotently) when a course reaches 100%. */
async function issueCertificateIfCompleted(enrollment: EnrollmentInfo, data: Awaited<ReturnType<typeof progressData>>) {
  if (!data.completed) return;
  try {
    const [existing] = await database.execute<RowDataPacket[]>(
      "SELECT id FROM certificates WHERE user_id = ? AND course_id = ? LIMIT 1",
      [enrollment.user_id, enrollment.course_id],
    );
    if (existing[0]) return;
    const certificateNo = `NEX-${String(enrollment.course_id).padStart(4, "0")}-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
    await database.execute(
      "INSERT INTO certificates (user_id, course_id, certificate_no) VALUES (?, ?, ?)",
      [enrollment.user_id, enrollment.course_id, certificateNo],
    );
    const [courseRows] = await database.execute<RowDataPacket[]>(
      "SELECT title FROM courses WHERE id = ? LIMIT 1",
      [enrollment.course_id],
    );
    const title = String(courseRows[0]?.title ?? "course");
    void notify(enrollment.user_id, "completion",
      `Course completed: "${title}"`, "Your certificate is ready.", "/profile");
  } catch (err) {
    // Certificate generation must never break the progress update itself.
    void err;
  }
}

export async function getProgress(request: Request, response: Response): Promise<void> {
  const enrollment = await getEnrollment(request);
  sendSuccess(response, await progressData(enrollment));
}

export async function updateProgress(request: Request, response: Response): Promise<void> {
  const enrollment = await getEnrollment(request);
  if (Number(enrollment.user_id) !== request.user?.id && request.user?.role !== "admin") {
    throw new AppError("Only the enrolled student can update progress", 403, "FORBIDDEN");
  }
  const lessonId = parsePositiveId(request.params.lessonId, "lesson id");
  const completedValue = (request.body as Record<string, unknown> | undefined)?.completed;
  if (typeof completedValue !== "boolean") {
    throw new AppError("completed must be a boolean", 400, "VALIDATION_ERROR");
  }
  const [lessons] = await database.execute<RowDataPacket[]>(
    "SELECT id FROM lessons WHERE id = ? AND course_id = ? LIMIT 1",
    [lessonId, enrollment.course_id],
  );
  if (!lessons[0]) throw new AppError("Lesson not found in this course", 404, "NOT_FOUND");

  if (completedValue) {
    await database.execute<ResultSetHeader>(
      `INSERT INTO enrollment_progress (enrollment_id, lesson_id, completed_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE completed_at = CURRENT_TIMESTAMP`,
      [enrollment.id, lessonId],
    );
  } else {
    await database.execute(
      "DELETE FROM enrollment_progress WHERE enrollment_id = ? AND lesson_id = ?",
      [enrollment.id, lessonId],
    );
  }
  const data = await progressData(enrollment);
  await issueCertificateIfCompleted(enrollment, data);
  sendSuccess(response, data, 200, "Progress updated");
}
