import { Request, Response } from "express";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import { database } from "../config/database";
import { AppError, parsePositiveId, sendSuccess } from "../utils/http";
import { notify } from "../utils/notifications";

interface QuizRow extends RowDataPacket { id: number; course_id: number; title: string; description: string | null; time_limit_minutes: number | null; passing_score: number; allowed_retakes?: number; course_title?: string; attempt_score?: number | null; attempt_passed?: number | null; attempt_count?: number | null; }
interface QuestionRow extends RowDataPacket { id: number; quiz_id: number; question: string; options: string | unknown[]; correct_option: number; position: number; }

function mapQuiz(row: QuizRow, questions?: QuestionRow[], reveal = false) {
  const attemptScore = row.attempt_score === null || row.attempt_score === undefined ? null : Number(row.attempt_score);
  const allowedRetakes = Number(row.allowed_retakes ?? 0);
  // Students see their best attempt; attempts left = 1 initial + retakes.
  const attemptCount = row.attempt_count === null || row.attempt_count === undefined ? 0 : Number(row.attempt_count);
  return {
    id: Number(row.id), courseId: Number(row.course_id), title: row.title, description: row.description,
    timeLimitMinutes: row.time_limit_minutes, passingScore: Number(row.passing_score),
    allowedRetakes, attemptCount, attemptsLeft: Math.max(0, 1 + allowedRetakes - attemptCount),
    courseTitle: row.course_title,
    attemptScore,
    attemptPassed: attemptScore === null ? null : attemptScore >= Number(row.passing_score),
    ...(questions ? { questions: questions.map((question) => ({ id: Number(question.id), quizId: Number(question.quiz_id), question: question.question, options: typeof question.options === "string" ? JSON.parse(question.options) : question.options, ...(reveal ? { correctOption: Number(question.correct_option) } : {}), position: Number(question.position) })) } : {}),
  };
}

async function ownedQuiz(request: Request) {
  const id = parsePositiveId(request.params.id, "quiz id");
  const [rows] = await database.execute<QuizRow[]>("SELECT q.* FROM quizzes q JOIN courses c ON c.id = q.course_id WHERE q.id = ? LIMIT 1", [id]);
  const quiz = rows[0];
  if (!quiz) throw new AppError("Quiz not found", 404, "NOT_FOUND");
  if (request.user?.role !== "admin") {
    const [owners] = await database.execute<RowDataPacket[]>("SELECT instructor_id FROM courses WHERE id = ?", [quiz.course_id]);
    if (Number(owners[0]?.instructor_id) !== request.user?.id) throw new AppError("You do not own this quiz", 403, "FORBIDDEN");
  }
  return quiz;
}

export async function listQuizzes(request: Request, response: Response) {
  const courseId = request.params.courseId ? parsePositiveId(request.params.courseId, "course id") : undefined;
  const isStudent = request.user?.role === "student";
  // Students only see quizzes from courses they are enrolled in — mirrors
  // listAssignments, because submitQuizAttempt requires enrollment anyway.
  const enrollmentJoin = isStudent
    ? "JOIN enrollments e ON e.course_id = q.course_id AND e.user_id = ?"
    : "";
  // TiDB rejects subqueries in a JOIN's ON condition, so the student's best
  // attempt (highest score) plus total attempt count per quiz are pre-computed
  // in a derived table — the best attempt is what lists and grades surface.
  const studentJoin = isStudent
    ? "LEFT JOIN (SELECT quiz_id, COUNT(*) attempt_count, MAX(score) best_score FROM quiz_attempts WHERE student_id = ? GROUP BY quiz_id) latest_attempt ON latest_attempt.quiz_id = q.id"
    : "";
  const attemptSelect = isStudent ? ", latest_attempt.attempt_count, latest_attempt.best_score attempt_score" : "";
  const query = courseId
    ? `SELECT q.*, c.title course_title${attemptSelect} FROM quizzes q JOIN courses c ON c.id = q.course_id ${enrollmentJoin} ${studentJoin} WHERE q.course_id = ? AND (c.status = 'published' OR c.instructor_id = ? OR ? = 1)`
    : `SELECT q.*, c.title course_title${attemptSelect} FROM quizzes q JOIN courses c ON c.id = q.course_id ${enrollmentJoin} ${studentJoin} WHERE c.status = 'published' OR c.instructor_id = ? OR ? = 1`;
  const uid = request.user?.id ?? 0;
  const adminFlag = request.user?.role === "admin" ? 1 : 0;
  // Placeholder order: enrollment user id, latest-attempt student id,
  // optional course filter, ownership check, admin flag.
  const params = courseId
    ? (isStudent ? [uid, uid, courseId, uid, adminFlag] : [courseId, uid, adminFlag])
    : (isStudent ? [uid, uid, uid, adminFlag] : [uid, adminFlag]);
  const [rows] = await database.execute<QuizRow[]>(query, params);
  sendSuccess(response, rows.map((row) => mapQuiz(row)));
}

export async function getQuiz(request: Request, response: Response) {
  const id = parsePositiveId(request.params.id, "quiz id");
  const [rows] = await database.execute<QuizRow[]>("SELECT q.*, c.instructor_id FROM quizzes q JOIN courses c ON c.id = q.course_id WHERE q.id = ? AND (c.status = 'published' OR c.instructor_id = ? OR ? = 1) LIMIT 1", [id, request.user?.id ?? 0, request.user?.role === "admin" ? 1 : 0]);
  if (!rows[0]) throw new AppError("Quiz not found", 404, "NOT_FOUND");
  const [questions] = await database.execute<QuestionRow[]>("SELECT id, quiz_id, question, options, correct_option, position FROM quiz_questions WHERE quiz_id = ? ORDER BY position, id", [id]);
  // Correct answers are only revealed to the quiz owner or an admin —
  // never to students or other instructors previewing a published quiz.
  const canReveal = request.user?.role === "admin" || Number(rows[0].instructor_id) === request.user?.id;
  sendSuccess(response, mapQuiz(rows[0], questions, canReveal));
}

export async function createQuiz(request: Request, response: Response) {
  const courseId = parsePositiveId(request.params.courseId, "course id");
  const [courses] = await database.execute<RowDataPacket[]>("SELECT instructor_id FROM courses WHERE id = ?", [courseId]);
  if (!courses[0]) throw new AppError("Course not found", 404, "NOT_FOUND");
  if (request.user?.role !== "admin" && Number(courses[0].instructor_id) !== request.user?.id) throw new AppError("You do not own this course", 403, "FORBIDDEN");
  const body = (request.body ?? {}) as Record<string, unknown>;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) throw new AppError("title is required", 400, "VALIDATION_ERROR");
  const [result] = await database.execute<ResultSetHeader>("INSERT INTO quizzes (course_id, title, description, time_limit_minutes, passing_score, allowed_retakes) VALUES (?, ?, ?, ?, ?, ?)", [courseId, title, typeof body.description === "string" ? body.description.trim() : null, typeof body.timeLimitMinutes === "number" ? body.timeLimitMinutes : null, typeof body.passingScore === "number" ? body.passingScore : 70, typeof body.allowedRetakes === "number" && Number.isInteger(body.allowedRetakes) && body.allowedRetakes >= 0 && body.allowedRetakes <= 20 ? body.allowedRetakes : 0]);
  const [rows] = await database.execute<QuizRow[]>("SELECT * FROM quizzes WHERE id = ?", [result.insertId]);
  sendSuccess(response, mapQuiz(rows[0]), 201, "Quiz created");
}

export async function updateQuiz(request: Request, response: Response) {
  const quiz = await ownedQuiz(request);
  const body = (request.body ?? {}) as Record<string, unknown>;
  const updates: string[] = []; const values: Array<string | number | null> = [];
  if (body.title !== undefined) { if (typeof body.title !== "string" || !body.title.trim()) throw new AppError("title cannot be empty", 400, "VALIDATION_ERROR"); updates.push("title = ?"); values.push(body.title.trim()); }
  if (body.description !== undefined) { updates.push("description = ?"); values.push(typeof body.description === "string" ? body.description.trim() : null); }
  if (body.timeLimitMinutes !== undefined) { if (typeof body.timeLimitMinutes !== "number" || body.timeLimitMinutes < 1) throw new AppError("timeLimitMinutes must be positive", 400, "VALIDATION_ERROR"); updates.push("time_limit_minutes = ?"); values.push(body.timeLimitMinutes); }
  if (body.passingScore !== undefined) { if (typeof body.passingScore !== "number" || body.passingScore < 0 || body.passingScore > 100) throw new AppError("passingScore must be between 0 and 100", 400, "VALIDATION_ERROR"); updates.push("passing_score = ?"); values.push(body.passingScore); }
  if (body.allowedRetakes !== undefined) { if (typeof body.allowedRetakes !== "number" || !Number.isInteger(body.allowedRetakes) || body.allowedRetakes < 0 || body.allowedRetakes > 20) throw new AppError("allowedRetakes must be an integer between 0 and 20", 400, "VALIDATION_ERROR"); updates.push("allowed_retakes = ?"); values.push(body.allowedRetakes); }
  if (!updates.length) throw new AppError("At least one field is required", 400, "VALIDATION_ERROR");
  values.push(quiz.id); await database.execute(`UPDATE quizzes SET ${updates.join(", ")} WHERE id = ?`, values);
  const [rows] = await database.execute<QuizRow[]>("SELECT * FROM quizzes WHERE id = ?", [quiz.id]); sendSuccess(response, mapQuiz(rows[0]));
}

export async function deleteQuiz(request: Request, response: Response) { const quiz = await ownedQuiz(request); await database.execute("DELETE FROM quizzes WHERE id = ?", [quiz.id]); sendSuccess(response, null, 200, "Quiz deleted"); }

export async function addQuizQuestion(request: Request, response: Response) {
  const quiz = await ownedQuiz(request); const body = (request.body ?? {}) as Record<string, unknown>;
  const correctOption = typeof body.correctOption === "number" ? body.correctOption : NaN;
  const options = Array.isArray(body.options) ? body.options : null;
  if (typeof body.question !== "string" || !body.question.trim() || !options || !Number.isInteger(correctOption) || correctOption < 0 || correctOption >= options.length) throw new AppError("question, options, and valid correctOption are required", 400, "VALIDATION_ERROR");
  const [result] = await database.execute<ResultSetHeader>("INSERT INTO quiz_questions (quiz_id, question, options, correct_option, position) VALUES (?, ?, ?, ?, ?)", [quiz.id, body.question.trim(), JSON.stringify(options), correctOption, typeof body.position === "number" ? body.position : 1]);
  sendSuccess(response, { id: result.insertId, quizId: quiz.id }, 201, "Question added");
}

export async function submitQuizAttempt(request: Request, response: Response) {
  if (!request.user || request.user.role !== "student") throw new AppError("Only students can submit quizzes", 403, "FORBIDDEN");
  const quizId = parsePositiveId(request.params.id, "quiz id"); const body = (request.body ?? {}) as Record<string, unknown>;
  const answers = body.answers;
  // Answers are keyed by question id (object map). A plain array is still
  // accepted for older clients, but sparse arrays indexed by TiDB's large
  // auto-increment ids used to blow the payload size up to megabytes.
  if (answers === null || typeof answers !== "object" || (Array.isArray(answers) && answers.length > 1000)) {
    throw new AppError("answers must be a map of question id to chosen option", 400, "VALIDATION_ERROR");
  }
  const [quizzes] = await database.execute<QuizRow[]>("SELECT * FROM quizzes WHERE id = ?", [quizId]); if (!quizzes[0]) throw new AppError("Quiz not found", 404, "NOT_FOUND");
  // Students must be enrolled in the quiz's course before attempting it.
  const [enrollments] = await database.execute<RowDataPacket[]>(
    "SELECT id FROM enrollments WHERE course_id = ? AND user_id = ? LIMIT 1",
    [Number(quizzes[0].course_id), request.user.id],
  );
  if (!enrollments[0]) throw new AppError("Enroll in the course before taking this quiz", 403, "ENROLLMENT_REQUIRED");
  // Retake limit: total attempts = 1 initial + instructor-configured retakes.
  const [attempted] = await database.execute<RowDataPacket[]>(
    "SELECT COUNT(*) count FROM quiz_attempts WHERE quiz_id = ? AND student_id = ?",
    [quizId, request.user.id],
  );
  const maxAttempts = 1 + Number(quizzes[0].allowed_retakes ?? 0);
  if (Number(attempted[0]?.count ?? 0) >= maxAttempts) {
    throw new AppError(`No attempts remaining for this quiz (${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"} allowed)`, 403, "RETAKE_LIMIT_REACHED");
  }
  const [questions] = await database.execute<QuestionRow[]>("SELECT * FROM quiz_questions WHERE quiz_id = ?", [quizId]); const answerFor = (questionId: number) => (answers as Record<string, unknown>)[String(questionId)]; const correct = questions.reduce((total, question) => total + (Number(answerFor(Number(question.id))) === Number(question.correct_option) ? 1 : 0), 0); const score = questions.length ? Math.round((correct / questions.length) * 100) : 0; const passed = score >= Number(quizzes[0].passing_score);
  const [result] = await database.execute<ResultSetHeader>("INSERT INTO quiz_attempts (quiz_id, student_id, answers, score, passed) VALUES (?, ?, ?, ?, ?)", [quizId, request.user.id, JSON.stringify(answers), score, passed ? 1 : 0]);
  void notify(request.user.id, "quiz", `Quiz "${quizzes[0].title}" scored ${score}%`, null, `/quizzes`);
  sendSuccess(response, { id: result.insertId, quizId, score, passed }, 201, "Quiz submitted");
}

export async function listQuizAttempts(request: Request, response: Response) {
  const quizId = parsePositiveId(request.params.id, "quiz id");
  const [rows] = await database.execute<RowDataPacket[]>("SELECT qa.id, qa.quiz_id, qa.student_id, u.name student_name, qa.score, qa.passed, qa.attempted_at FROM quiz_attempts qa JOIN users u ON u.id = qa.student_id WHERE qa.quiz_id = ? AND (qa.student_id = ? OR ? = 1 OR EXISTS (SELECT 1 FROM quizzes q JOIN courses c ON c.id = q.course_id WHERE q.id = qa.quiz_id AND c.instructor_id = ?)) ORDER BY qa.attempted_at DESC", [quizId, request.user?.id ?? 0, request.user?.role === "admin" ? 1 : 0, request.user?.id ?? 0]);
  sendSuccess(response, rows.map((row) => ({ id: Number(row.id), quizId: Number(row.quiz_id), studentId: Number(row.student_id), studentName: row.student_name, score: Number(row.score), passed: Boolean(row.passed), attemptedAt: row.attempted_at })));
}
