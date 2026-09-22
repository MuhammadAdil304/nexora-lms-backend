import { Request, Response } from "express";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import { database } from "../config/database";
import { AppError, parsePositiveId, sendSuccess } from "../utils/http";
import { notify } from "../utils/notifications";

interface AssignmentRow extends RowDataPacket {
  id: number; course_id: number; title: string; description: string | null;
  due_at: Date | null; max_score: number; course_title?: string;
  submission_status?: string | null; submission_score?: number | null;
}

function assignment(row: AssignmentRow) {
  return { id: Number(row.id), courseId: Number(row.course_id), title: row.title,
    description: row.description, dueAt: row.due_at, maxScore: Number(row.max_score),
    courseTitle: row.course_title,
    submissionStatus: row.submission_status ?? null,
    submissionScore: row.submission_score === null || row.submission_score === undefined
      ? null : Number(row.submission_score),
  };
}

async function ownedCourse(courseId: number, user: Request["user"]) {
  const [rows] = await database.execute<RowDataPacket[]>(
    "SELECT instructor_id FROM courses WHERE id = ?", [courseId],
  );
  if (!rows[0]) throw new AppError("Course not found", 404, "NOT_FOUND");
  if (user?.role !== "admin" && Number(rows[0].instructor_id) !== user?.id) {
    throw new AppError("You do not own this course", 403, "FORBIDDEN");
  }
}

export async function listAssignments(request: Request, response: Response) {
  const courseId = request.params.courseId
    ? parsePositiveId(request.params.courseId, "course id") : undefined;
  const userId = request.user?.id ?? 0;
  const role = request.user?.role;
  const scope = role === "student"
    ? "JOIN enrollments e ON e.course_id = a.course_id AND e.user_id = ? LEFT JOIN assignment_submissions own_submission ON own_submission.assignment_id = a.id AND own_submission.student_id = ?"
    : role === "instructor"
      ? "JOIN courses owned_course ON owned_course.id = a.course_id AND owned_course.instructor_id = ?"
      : "";
  const where = courseId ? "WHERE a.course_id = ?" : "";
  const params = role === "student"
    ? (courseId ? [userId, userId, courseId] : [userId, userId])
    : role === "instructor"
      ? (courseId ? [userId, courseId] : [userId])
      : (courseId ? [courseId] : []);
  const [rows] = await database.execute<AssignmentRow[]>(
    `SELECT a.*, c.title course_title${role === "student" ? ", own_submission.status submission_status, own_submission.score submission_score" : ""}
     FROM assignments a JOIN courses c ON c.id = a.course_id ${scope} ${where}
     ORDER BY a.due_at IS NULL, a.due_at, a.id DESC`, params,
  );
  sendSuccess(response, rows.map(assignment));
}

export async function getAssignment(request: Request, response: Response) {
  const id = parsePositiveId(request.params.assignmentId, "assignment id");
  const [rows] = await database.execute<AssignmentRow[]>(
    `SELECT a.*, c.title course_title, c.status course_status, c.instructor_id
     FROM assignments a JOIN courses c ON c.id = a.course_id WHERE a.id = ? LIMIT 1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new AppError("Assignment not found", 404, "NOT_FOUND");
  const role = request.user?.role;
  if (role !== "admin" && Number(row.instructor_id) !== request.user?.id) {
    // Students may only open assignments for courses they are enrolled in.
    const [enrollments] = await database.execute<RowDataPacket[]>(
      "SELECT id FROM enrollments WHERE course_id = ? AND user_id = ? LIMIT 1",
      [Number(row.course_id), request.user?.id ?? 0],
    );
    if (role !== "student" || !enrollments[0]) {
      throw new AppError("Assignment not found", 404, "NOT_FOUND");
    }
  }
  sendSuccess(response, assignment(row));
}

/**
 * All submissions across the instructor's courses (or a single student's own
 * submissions) — avoids the frontend N+1 of fetching per assignment.
 */
export async function listAllSubmissions(request: Request, response: Response) {
  const role = request.user?.role;
  if (role === "student") {
    const [rows] = await database.execute<RowDataPacket[]>(
      `SELECT s.id, s.assignment_id, s.student_id, u.name student_name, a.title assignment_title,
              a.course_id, s.submission_url, s.comment, s.status, s.score, s.feedback, s.submitted_at, s.graded_at
       FROM assignment_submissions s
       JOIN assignments a ON a.id = s.assignment_id
       JOIN users u ON u.id = s.student_id
       WHERE s.student_id = ? ORDER BY s.submitted_at DESC`,
      [request.user?.id ?? 0],
    );
    sendSuccess(response, rows.map(mapSubmissionRow));
    return;
  }
  if (role === "instructor") {
    const [rows] = await database.execute<RowDataPacket[]>(
      `SELECT s.id, s.assignment_id, s.student_id, u.name student_name, a.title assignment_title,
              a.course_id, s.submission_url, s.comment, s.status, s.score, s.feedback, s.submitted_at, s.graded_at
       FROM assignment_submissions s
       JOIN assignments a ON a.id = s.assignment_id
       JOIN courses c ON c.id = a.course_id
       JOIN users u ON u.id = s.student_id
       WHERE c.instructor_id = ? ORDER BY s.submitted_at DESC`,
      [request.user?.id ?? 0],
    );
    sendSuccess(response, rows.map(mapSubmissionRow));
    return;
  }
  throw new AppError("You do not have permission to perform this action", 403, "FORBIDDEN");
}

function mapSubmissionRow(row: RowDataPacket) {
  return {
    id: Number(row.id),
    assignmentId: Number(row.assignment_id),
    assignmentTitle: row.assignment_title,
    courseId: Number(row.course_id),
    studentId: Number(row.student_id),
    studentName: row.student_name,
    submissionUrl: row.submission_url,
    comment: row.comment,
    status: row.status,
    score: row.score === null ? null : Number(row.score),
    feedback: row.feedback,
    submittedAt: row.submitted_at,
    gradedAt: row.graded_at,
  };
}

export async function createAssignment(request: Request, response: Response) {
  const courseId = parsePositiveId(request.params.courseId, "course id");
  await ownedCourse(courseId, request.user);
  const body = (request.body ?? {}) as Record<string, unknown>;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) throw new AppError("title is required", 400, "VALIDATION_ERROR");
  const [result] = await database.execute<ResultSetHeader>(
    "INSERT INTO assignments (course_id, title, description, due_at, max_score) VALUES (?, ?, ?, ?, ?)",
    [courseId, title, typeof body.description === "string" ? body.description.trim() : null,
      typeof body.dueAt === "string" ? body.dueAt : null,
      typeof body.maxScore === "number" ? body.maxScore : 100],
  );
  const [rows] = await database.execute<AssignmentRow[]>("SELECT * FROM assignments WHERE id = ?", [result.insertId]);
  sendSuccess(response, assignment(rows[0]), 201, "Assignment created");
}

export async function updateAssignment(request: Request, response: Response) {
  const id = parsePositiveId(request.params.assignmentId, "assignment id");
  const [rows] = await database.execute<AssignmentRow[]>("SELECT * FROM assignments WHERE id = ?", [id]);
  if (!rows[0]) throw new AppError("Assignment not found", 404, "NOT_FOUND");
  await ownedCourse(Number(rows[0].course_id), request.user);
  const body = (request.body ?? {}) as Record<string, unknown>;
  const updates: string[] = []; const values: Array<string | number | null> = [];
  if (body.title !== undefined) { if (typeof body.title !== "string" || !body.title.trim()) throw new AppError("title cannot be empty", 400, "VALIDATION_ERROR"); updates.push("title = ?"); values.push(body.title.trim()); }
  if (body.description !== undefined) { updates.push("description = ?"); values.push(typeof body.description === "string" ? body.description.trim() : null); }
  if (body.dueAt !== undefined) { updates.push("due_at = ?"); values.push(typeof body.dueAt === "string" ? body.dueAt : null); }
  if (body.maxScore !== undefined) { if (typeof body.maxScore !== "number" || body.maxScore <= 0) throw new AppError("maxScore must be positive", 400, "VALIDATION_ERROR"); updates.push("max_score = ?"); values.push(body.maxScore); }
  if (!updates.length) throw new AppError("At least one field is required", 400, "VALIDATION_ERROR");
  values.push(id); await database.execute(`UPDATE assignments SET ${updates.join(", ")} WHERE id = ?`, values);
  const [updated] = await database.execute<AssignmentRow[]>("SELECT * FROM assignments WHERE id = ?", [id]); sendSuccess(response, assignment(updated[0]));
}

export async function deleteAssignment(request: Request, response: Response) {
  const id = parsePositiveId(request.params.assignmentId, "assignment id");
  const [rows] = await database.execute<AssignmentRow[]>("SELECT * FROM assignments WHERE id = ?", [id]);
  if (!rows[0]) throw new AppError("Assignment not found", 404, "NOT_FOUND");
  await ownedCourse(Number(rows[0].course_id), request.user);
  await database.execute("DELETE FROM assignments WHERE id = ?", [id]);
  sendSuccess(response, null, 200, "Assignment deleted");
}

export async function listSubmissions(request: Request, response: Response) {
  const assignmentId = parsePositiveId(request.params.assignmentId, "assignment id");
  const [assignmentRows] = await database.execute<RowDataPacket[]>(
    "SELECT course_id FROM assignments WHERE id = ?", [assignmentId],
  );
  if (!assignmentRows[0]) throw new AppError("Assignment not found", 404, "NOT_FOUND");
  await ownedCourse(Number(assignmentRows[0].course_id), request.user);
  const [rows] = await database.execute<RowDataPacket[]>(
    `SELECT s.*, u.name student_name, u.email student_email FROM assignment_submissions s
     JOIN users u ON u.id = s.student_id WHERE s.assignment_id = ? ORDER BY s.submitted_at DESC`, [assignmentId],
  );
  sendSuccess(response, rows.map((row) => ({ id: Number(row.id), assignmentId: Number(row.assignment_id),
    studentId: Number(row.student_id), studentName: row.student_name, studentEmail: row.student_email,
    submissionUrl: row.submission_url, comment: row.comment, status: row.status, score: row.score,
    feedback: row.feedback, submittedAt: row.submitted_at, gradedAt: row.graded_at })));
}

export async function submitAssignment(request: Request, response: Response) {
  const assignmentId = parsePositiveId(request.params.assignmentId, "assignment id");
  if (!request.user) throw new AppError("Authentication token is required", 401, "UNAUTHORIZED");
  const [assignmentRows] = await database.execute<RowDataPacket[]>(
    "SELECT course_id, title FROM assignments WHERE id = ?", [assignmentId],
  );
  if (!assignmentRows[0]) throw new AppError("Assignment not found", 404, "NOT_FOUND");
  const [enrollments] = await database.execute<RowDataPacket[]>(
    "SELECT id FROM enrollments WHERE course_id = ? AND user_id = ?",
    [assignmentRows[0].course_id, request.user.id],
  );
  if (!enrollments[0]) throw new AppError("Enroll in the course before submitting work", 403, "FORBIDDEN");
  const body = (request.body ?? {}) as Record<string, unknown>;
  const [result] = await database.execute<ResultSetHeader>(
    `INSERT INTO assignment_submissions (assignment_id, student_id, submission_url, comment)
     VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE submission_url = VALUES(submission_url),
     comment = VALUES(comment), status = 'submitted', submitted_at = CURRENT_TIMESTAMP`,
    [assignmentId, request.user.id,
      typeof body.submissionUrl === "string" ? body.submissionUrl.trim() : null,
      typeof body.comment === "string" ? body.comment.trim() : null],
  );
  const [instructorRows] = await database.execute<RowDataPacket[]>(
    "SELECT c.instructor_id FROM courses c JOIN assignments a ON a.course_id = c.id WHERE a.id = ? LIMIT 1",
    [assignmentId],
  );
  if (instructorRows[0]) {
    void notify(Number(instructorRows[0].instructor_id), "grade",
      `New submission for "${assignmentRows[0].title ?? "assignment"}" from ${request.user.name}`,
      null, "/grading");
  }
  sendSuccess(response, { id: Number(result.insertId), assignmentId, studentId: request.user.id }, 201, "Assignment submitted");
}

export async function gradeSubmission(request: Request, response: Response) {
  const submissionId = parsePositiveId(request.params.submissionId, "submission id");
  const body = (request.body ?? {}) as Record<string, unknown>;
  if (typeof body.score !== "number" || body.score < 0) {
    throw new AppError("score must be a non-negative number", 400, "VALIDATION_ERROR");
  }
  const [rows] = await database.execute<RowDataPacket[]>(
    `SELECT a.course_id, a.title, a.max_score, s.student_id FROM assignment_submissions s JOIN assignments a ON a.id = s.assignment_id
     WHERE s.id = ?`, [submissionId],
  );
  if (!rows[0]) throw new AppError("Submission not found", 404, "NOT_FOUND");
  if (Number(body.score) > Number(rows[0].max_score)) {
    throw new AppError(`score cannot exceed the assignment max score (${rows[0].max_score})`, 400, "VALIDATION_ERROR");
  }
  await ownedCourse(Number(rows[0].course_id), request.user);
  await database.execute(
    "UPDATE assignment_submissions SET score = ?, feedback = ?, status = 'graded', graded_at = CURRENT_TIMESTAMP WHERE id = ?",
    [body.score, typeof body.feedback === "string" ? body.feedback.trim() : null, submissionId],
  );
  void notify(Number(rows[0].student_id), "grade",
    `Your submission for "${rows[0].title}" was graded: ${body.score}`,
    typeof body.feedback === "string" ? body.feedback.trim() : null, "/grades");
  sendSuccess(response, null, 200, "Submission graded");
}
