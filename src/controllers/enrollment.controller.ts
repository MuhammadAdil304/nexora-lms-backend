import { Request, Response } from "express";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import { database } from "../config/database";
import { AppError, parsePositiveId, sendSuccess } from "../utils/http";
import { notify } from "../utils/notifications";

interface EnrollmentRow extends RowDataPacket {
  id: number;
  user_id: number;
  course_id: number;
  enrolled_at: Date;
  course_title?: string;
  course_status?: string;
  student_name?: string;
  total_lessons?: number | null;
  completed_lessons?: number | null;
}

function mapEnrollment(row: EnrollmentRow) {
  const totalLessons = Number(row.total_lessons ?? 0);
  const completedLessons = Number(row.completed_lessons ?? 0);
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    courseId: Number(row.course_id),
    courseTitle: row.course_title,
    courseStatus: row.course_status,
    studentName: row.student_name,
    enrolledAt: row.enrolled_at,
    ...(row.total_lessons === undefined && row.completed_lessons === undefined
      ? {}
      : {
        totalLessons,
        completedLessons,
        progressPercentage: totalLessons === 0
          ? 0
          : Math.round((completedLessons / totalLessons) * 100),
      }),
  };
}

async function findEnrollment(request: Request, enrollmentId: number): Promise<EnrollmentRow> {
  const [rows] = await database.execute<EnrollmentRow[]>(
    `SELECT e.*, c.title course_title, c.status course_status, u.name student_name
     FROM enrollments e
     JOIN courses c ON c.id = e.course_id
     JOIN users u ON u.id = e.user_id
     WHERE e.id = ? LIMIT 1`,
    [enrollmentId],
  );
  const enrollment = rows[0];
  if (!enrollment) throw new AppError("Enrollment not found", 404, "NOT_FOUND");
  const isOwner = Number(enrollment.user_id) === request.user?.id;
  if (!isOwner && request.user?.role !== "admin") {
    const [courseRows] = await database.execute<RowDataPacket[]>(
      "SELECT instructor_id FROM courses WHERE id = ?", [enrollment.course_id],
    );
    if (!courseRows[0] || Number(courseRows[0].instructor_id) !== request.user?.id) {
      throw new AppError("You do not have access to this enrollment", 403, "FORBIDDEN");
    }
  }
  return enrollment;
}

export async function enrollInCourse(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Authentication token is required", 401, "UNAUTHORIZED");
  const bodyCourseId = (request.body as Record<string, unknown> | undefined)?.courseId;
  const courseId = parsePositiveId(
    request.params.courseId ?? String(bodyCourseId ?? ""),
    "course id",
  );
  const [courses] = await database.execute<RowDataPacket[]>(
    "SELECT id, title, status, instructor_id FROM courses WHERE id = ? LIMIT 1", [courseId],
  );
  const course = courses[0];
  if (!course || course.status !== "published") {
    throw new AppError("Course not found", 404, "NOT_FOUND");
  }
  if (Number(course.instructor_id) === request.user.id) {
    throw new AppError("Instructors cannot enroll in their own course", 400, "INVALID_ENROLLMENT");
  }
  const [existing] = await database.execute<EnrollmentRow[]>(
    "SELECT * FROM enrollments WHERE user_id = ? AND course_id = ? LIMIT 1",
    [request.user.id, courseId],
  );
  if (existing[0]) {
    sendSuccess(response, mapEnrollment(existing[0]), 200, "Already enrolled");
    return;
  }
  const [result] = await database.execute<ResultSetHeader>(
    "INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)",
    [request.user.id, courseId],
  );
  const [rows] = await database.execute<EnrollmentRow[]>(
    `SELECT e.*, c.title course_title, c.status course_status
     FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.id = ?`,
    [result.insertId],
  );
  void notify(request.user.id, "enrollment", `You enrolled in "${course.title}"`, null, `/courses/${courseId}`);
  void notify(Number(course.instructor_id), "enrollment", `${request.user.name} enrolled in "${course.title}"`, null, `/courses/${courseId}`);
  sendSuccess(response, mapEnrollment(rows[0]), 201, "Enrolled successfully");
}

export async function listMyEnrollments(request: Request, response: Response): Promise<void> {
  const [rows] = await database.execute<EnrollmentRow[]>(
    `SELECT e.*, c.title course_title, c.status course_status,
       (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id) total_lessons,
       (SELECT COUNT(*) FROM enrollment_progress ep
         WHERE ep.enrollment_id = e.id AND ep.completed_at IS NOT NULL) completed_lessons
     FROM enrollments e JOIN courses c ON c.id = e.course_id
     WHERE e.user_id = ? ORDER BY e.enrolled_at DESC`,
    [request.user?.id ?? 0],
  );
  sendSuccess(response, rows.map(mapEnrollment));
}

export async function getEnrollment(request: Request, response: Response): Promise<void> {
  const enrollment = await findEnrollment(request, parsePositiveId(request.params.id, "enrollment id"));
  sendSuccess(response, mapEnrollment(enrollment));
}

export async function deleteEnrollment(request: Request, response: Response): Promise<void> {
  const enrollment = await findEnrollment(request, parsePositiveId(request.params.id, "enrollment id"));
  if (Number(enrollment.user_id) !== request.user?.id && request.user?.role !== "admin") {
    throw new AppError("Only the enrolled student or an admin can cancel this enrollment", 403, "FORBIDDEN");
  }
  await database.execute("DELETE FROM enrollments WHERE id = ?", [enrollment.id]);
  sendSuccess(response, null, 200, "Enrollment cancelled");
}
