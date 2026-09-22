import { Request, Response } from "express";
import { RowDataPacket } from "mysql2";
import { database } from "../config/database";
import { AppError, sendSuccess } from "../utils/http";

interface GradeRow extends RowDataPacket {
  kind: "assignment" | "quiz";
  id: number;
  title: string;
  course_id: number;
  course_title: string;
  score: number | null;
  max_score: number;
  status: string | null;
  date: Date | null;
}

/**
 * Combined student results: graded assignment submissions plus quiz
 * attempts, with overall averages — powers the "Grades & Results" page.
 */
export async function getMyGrades(request: Request, response: Response): Promise<void> {
  const userId = request.user?.id;
  if (!userId) throw new AppError("Authentication token is required", 401, "UNAUTHORIZED");

  const [rows] = await database.execute<GradeRow[]>(
    `SELECT 'assignment' kind, a.id, a.title, c.id course_id, c.title course_title,
            s.score, a.max_score, s.status, COALESCE(s.graded_at, s.submitted_at) date
     FROM assignment_submissions s
     JOIN assignments a ON a.id = s.assignment_id
     JOIN courses c ON c.id = a.course_id
     WHERE s.student_id = ?
     UNION ALL
     SELECT 'quiz' kind, q.id, q.title, c.id course_id, c.title course_title,
            qa.score, 100 max_score, IF(qa.passed = 1, 'passed', 'failed') status, qa.attempted_at date
     FROM (
       SELECT MAX(qa2.id) id
       FROM quiz_attempts qa2
       JOIN (SELECT quiz_id, MAX(score) best_score FROM quiz_attempts WHERE student_id = ? GROUP BY quiz_id) t
         ON t.quiz_id = qa2.quiz_id AND t.best_score = qa2.score
       WHERE qa2.student_id = ?
       GROUP BY qa2.quiz_id
     ) best_ids
     JOIN quiz_attempts qa ON qa.id = best_ids.id
     JOIN quizzes q ON q.id = qa.quiz_id
     JOIN courses c ON c.id = q.course_id
     ORDER BY date IS NULL, date DESC`,
    [userId, userId, userId],
  );

  // Best (highest) quiz attempt per quiz counts toward the average.
  const [quizBest] = await database.execute<RowDataPacket[]>(
    `SELECT COALESCE(AVG(best.score), 0) average, COUNT(*) count
     FROM (SELECT MAX(qa.score) score
           FROM quiz_attempts qa
           WHERE qa.student_id = ?
           GROUP BY qa.quiz_id) best`,
    [userId],
  );
  const [assignmentAverages] = await database.execute<RowDataPacket[]>(
    `SELECT COALESCE(AVG(s.score / a.max_score * 100), 0) average, COUNT(*) count
     FROM assignment_submissions s
     JOIN assignments a ON a.id = s.assignment_id
     WHERE s.student_id = ? AND s.score IS NOT NULL AND a.max_score > 0`,
    [userId],
  );

  const assignmentAverage = Number(assignmentAverages[0]?.average ?? 0);
  const quizAverage = Number(quizBest[0]?.average ?? 0);
  const gradedCount = Number(assignmentAverages[0]?.count ?? 0);
  const quizCount = Number(quizBest[0]?.count ?? 0);
  const overall = gradedCount + quizCount === 0
    ? 0
    : Math.round(((assignmentAverage * gradedCount + quizAverage * quizCount) / (gradedCount + quizCount)) * 10) / 10;

  sendSuccess(response, {
    results: rows.map((row) => ({
      kind: row.kind,
      id: Number(row.id),
      title: row.title,
      courseId: Number(row.course_id),
      courseTitle: row.course_title,
      score: row.score === null ? null : Number(row.score),
      maxScore: Number(row.max_score),
      percent: row.score === null || !Number(row.max_score)
        ? null
        : Math.round((Number(row.score) / Number(row.max_score)) * 100),
      status: row.status,
      date: row.date,
    })),
    summary: {
      assignmentAverage: Math.round(assignmentAverage * 10) / 10,
      quizAverage: Math.round(quizAverage * 10) / 10,
      overall,
      gradedAssignments: gradedCount,
      quizAttempts: quizCount,
    },
  });
}
