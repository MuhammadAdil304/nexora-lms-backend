import { Request, Response } from "express";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import { database } from "../config/database";
import { AppError, parsePositiveId, sendSuccess } from "../utils/http";

interface ReviewRow extends RowDataPacket {
  id: number;
  user_id: number;
  name: string;
  rating: number;
  comment: string | null;
  created_at: Date;
}

/** List reviews for a course (public alongside the course itself). */
export async function listCourseReviews(request: Request, response: Response): Promise<void> {
  const courseId = parsePositiveId(request.params.id, "course id");
  const [rows] = await database.execute<ReviewRow[]>(
    `SELECT r.id, r.user_id, u.name, r.rating, r.comment, r.created_at
     FROM course_reviews r JOIN users u ON u.id = r.user_id
     WHERE r.course_id = ? ORDER BY r.created_at DESC LIMIT 50`,
    [courseId],
  );
  const [[aggregate]] = await database.execute<RowDataPacket[]>(
    "SELECT COUNT(*) count, COALESCE(AVG(rating), 0) average FROM course_reviews WHERE course_id = ?",
    [courseId],
  );
  sendSuccess(response, {
    average: Math.round(Number(aggregate.average) * 10) / 10,
    count: Number(aggregate.count),
    reviews: rows.map((row) => ({
      id: Number(row.id),
      userId: Number(row.user_id),
      name: row.name,
      rating: Number(row.rating),
      comment: row.comment,
      createdAt: row.created_at,
    })),
  });
}

/** Create or update the calling student's review for a course. */
export async function createCourseReview(request: Request, response: Response): Promise<void> {
  const courseId = parsePositiveId(request.params.id, "course id");
  const userId = request.user?.id;
  if (!userId) throw new AppError("Authentication token is required", 401, "UNAUTHORIZED");

  const body = (request.body ?? {}) as Record<string, unknown>;
  const rating = typeof body.rating === "number" ? Math.floor(body.rating) : NaN;
  if (!Number.isSafeInteger(rating) || rating < 1 || rating > 5) {
    throw new AppError("rating must be an integer between 1 and 5", 400, "VALIDATION_ERROR");
  }
  const comment = typeof body.comment === "string" && body.comment.trim()
    ? body.comment.trim().slice(0, 2000)
    : null;

  const [courses] = await database.execute<RowDataPacket[]>(
    "SELECT id FROM courses WHERE id = ? AND status = 'published' LIMIT 1",
    [courseId],
  );
  if (!courses[0]) throw new AppError("Course not found", 404, "NOT_FOUND");

  // Only enrolled students may review a course.
  const [enrollments] = await database.execute<RowDataPacket[]>(
    "SELECT id FROM enrollments WHERE course_id = ? AND user_id = ? LIMIT 1",
    [courseId, userId],
  );
  if (!enrollments[0] && request.user?.role !== "admin") {
    throw new AppError("Only enrolled students can review this course", 403, "REVIEW_NOT_ALLOWED");
  }

  await database.execute<ResultSetHeader>(
    `INSERT INTO course_reviews (course_id, user_id, rating, comment)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE rating = VALUES(rating), comment = VALUES(comment)`,
    [courseId, userId, rating, comment],
  );

  const [rows] = await database.execute<ReviewRow[]>(
    `SELECT r.id, r.user_id, u.name, r.rating, r.comment, r.created_at
     FROM course_reviews r JOIN users u ON u.id = r.user_id
     WHERE r.course_id = ? AND r.user_id = ? LIMIT 1`,
    [courseId, userId],
  );
  const review = rows[0];
  sendSuccess(response, {
    id: Number(review.id),
    userId: Number(review.user_id),
    name: review.name,
    rating: Number(review.rating),
    comment: review.comment,
    createdAt: review.created_at,
  }, 201, "Review saved");
}

/** The calling student's completion certificates. */
export async function listMyCertificates(request: Request, response: Response): Promise<void> {
  const userId = request.user?.id;
  if (!userId) throw new AppError("Authentication token is required", 401, "UNAUTHORIZED");
  const [rows] = await database.execute<RowDataPacket[]>(
    `SELECT cert.id, cert.certificate_no, cert.issued_at, c.id course_id, c.title course_title, u.name instructor_name
     FROM certificates cert
     JOIN courses c ON c.id = cert.course_id
     JOIN users u ON u.id = c.instructor_id
     WHERE cert.user_id = ?
     ORDER BY cert.issued_at DESC`,
    [userId],
  );
  sendSuccess(response, rows.map((row) => ({
    id: Number(row.id),
    certificateNo: row.certificate_no,
    courseId: Number(row.course_id),
    courseTitle: row.course_title,
    instructorName: row.instructor_name,
    issuedAt: row.issued_at,
  })));
}
