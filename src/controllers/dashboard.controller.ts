import { Request, Response } from "express";
import { RowDataPacket } from "mysql2";
import { database } from "../config/database";
import { AppError, sendSuccess } from "../utils/http";

export async function getDashboardSummary(request: Request, response: Response) {
  if (!request.user) throw new AppError("Authentication token is required", 401, "UNAUTHORIZED");
  const userId = request.user.id;
  if (request.user.role === "admin") {
    const [
      [users],
      [courses],
      [enrollments],
      [pending],
      [monthlyEnrollments],
      [activity],
      [recentTeacherRequests],
      [recentRegistrations],
    ] = await Promise.all([
      database.execute<RowDataPacket[]>("SELECT COUNT(*) total, SUM(role = 'student') students, SUM(role = 'instructor') instructors FROM users"),
      database.execute<RowDataPacket[]>("SELECT COUNT(*) total, SUM(status = 'published') published FROM courses"),
      database.execute<RowDataPacket[]>("SELECT COUNT(*) total FROM enrollments"),
      database.execute<RowDataPacket[]>("SELECT COUNT(*) total FROM users WHERE role = 'instructor' AND status = 'pending'"),
      database.execute<RowDataPacket[]>(
        `SELECT MONTH(enrolled_at) month, COUNT(*) total
         FROM enrollments
         WHERE YEAR(enrolled_at) = YEAR(CURRENT_DATE)
         GROUP BY MONTH(enrolled_at)
         ORDER BY month`,
      ),
      database.execute<RowDataPacket[]>(
        `SELECT
          (SELECT COUNT(*) FROM enrollments WHERE DATE(enrolled_at) = CURRENT_DATE) course_enrollments,
          (SELECT COUNT(*) FROM enrollment_progress WHERE completed_at IS NOT NULL AND DATE(completed_at) = CURRENT_DATE) lessons_completed,
          (SELECT COUNT(*) FROM assignment_submissions WHERE DATE(submitted_at) = CURRENT_DATE) assignments_submitted,
          (SELECT COUNT(*) FROM users WHERE DATE(created_at) = CURRENT_DATE) new_registrations`,
      ),
      database.execute<RowDataPacket[]>(
        "SELECT id, name, email, status, created_at FROM users WHERE role = 'instructor' AND status = 'pending' ORDER BY created_at DESC LIMIT 5",
      ),
      database.execute<RowDataPacket[]>(
        "SELECT id, name, email, role, status, created_at FROM users ORDER BY created_at DESC LIMIT 5",
      ),
    ]);
    sendSuccess(response, {
      role: "admin",
      users: users[0],
      courses: courses[0],
      enrollments: enrollments[0],
      pendingTeachers: pending[0].total,
      monthlyEnrollments,
      activity: activity[0],
      recentTeacherRequests,
      recentRegistrations,
    });
    return;
  }
  if (request.user.role === "instructor") {
    const [
      [courses],
      [students],
      [assignments],
      [submissions],
      [pendingSubmissions],
      [performance],
      [studentProgress],
      [recentSubmissions],
    ] = await Promise.all([
      database.execute<RowDataPacket[]>("SELECT COUNT(*) total, SUM(status = 'published') published FROM courses WHERE instructor_id = ?", [userId]),
      database.execute<RowDataPacket[]>("SELECT COUNT(DISTINCT e.user_id) total FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE c.instructor_id = ?", [userId]),
      database.execute<RowDataPacket[]>("SELECT COUNT(*) total FROM assignments a JOIN courses c ON c.id = a.course_id WHERE c.instructor_id = ?", [userId]),
      database.execute<RowDataPacket[]>("SELECT COUNT(*) total FROM assignment_submissions s JOIN assignments a ON a.id = s.assignment_id JOIN courses c ON c.id = a.course_id WHERE c.instructor_id = ?", [userId]),
      database.execute<RowDataPacket[]>(
        "SELECT COUNT(*) total FROM assignment_submissions s JOIN assignments a ON a.id = s.assignment_id JOIN courses c ON c.id = a.course_id WHERE c.instructor_id = ? AND s.status <> 'graded'",
        [userId],
      ),
      database.execute<RowDataPacket[]>(
        `SELECT DATE(s.submitted_at) day, COUNT(*) total
         FROM assignment_submissions s
         JOIN assignments a ON a.id = s.assignment_id
         JOIN courses c ON c.id = a.course_id
         WHERE c.instructor_id = ? AND s.submitted_at >= DATE_SUB(CURRENT_DATE, INTERVAL 6 DAY)
         GROUP BY DATE(s.submitted_at)
         ORDER BY day`,
        [userId],
      ),
      database.execute<RowDataPacket[]>(
        `SELECT u.id student_id, u.name student_name,
          COUNT(DISTINCT l.id) total_lessons,
          COUNT(DISTINCT ep.lesson_id) completed_lessons
         FROM users u
         JOIN enrollments e ON e.user_id = u.id
         JOIN courses c ON c.id = e.course_id
         LEFT JOIN lessons l ON l.course_id = c.id
         LEFT JOIN enrollment_progress ep ON ep.enrollment_id = e.id AND ep.lesson_id = l.id AND ep.completed_at IS NOT NULL
         WHERE c.instructor_id = ?
         GROUP BY u.id, u.name
         ORDER BY completed_lessons DESC, u.name
         LIMIT 5`,
        [userId],
      ),
      database.execute<RowDataPacket[]>(
        `SELECT s.id, s.assignment_id, s.student_id, s.status, s.score, s.submitted_at,
          u.name student_name, u.email student_email, a.title assignment_title
         FROM assignment_submissions s
         JOIN assignments a ON a.id = s.assignment_id
         JOIN courses c ON c.id = a.course_id
         JOIN users u ON u.id = s.student_id
         WHERE c.instructor_id = ? AND s.status <> 'graded'
         ORDER BY s.submitted_at DESC
         LIMIT 5`,
        [userId],
      ),
    ]);
    sendSuccess(response, {
      role: "instructor",
      courses: courses[0],
      students: students[0],
      assignments: assignments[0],
      submissions: submissions[0],
      pendingSubmissions: pendingSubmissions[0],
      performance,
      studentProgress,
      recentSubmissions,
    });
    return;
  }
  const [
    [enrollments],
    [assignments],
    [grades],
    [courseProgress],
    [upcoming],
    [recentGrades],
    [recentActivity],
  ] = await Promise.all([
    database.execute<RowDataPacket[]>("SELECT COUNT(*) total FROM enrollments WHERE user_id = ?", [userId]),
    database.execute<RowDataPacket[]>("SELECT COUNT(*) total FROM assignments a JOIN enrollments e ON e.course_id = a.course_id WHERE e.user_id = ? AND NOT EXISTS (SELECT 1 FROM assignment_submissions s WHERE s.assignment_id = a.id AND s.student_id = ?)", [userId, userId]),
    database.execute<RowDataPacket[]>("SELECT COUNT(*) total, AVG(score) average FROM assignment_submissions WHERE student_id = ? AND score IS NOT NULL", [userId]),
    database.execute<RowDataPacket[]>(
      `SELECT e.id enrollment_id, c.id course_id, c.title course_title,
        COUNT(DISTINCT l.id) total_lessons,
        COUNT(DISTINCT ep.lesson_id) completed_lessons
       FROM enrollments e
       JOIN courses c ON c.id = e.course_id
       LEFT JOIN lessons l ON l.course_id = c.id
       LEFT JOIN enrollment_progress ep ON ep.enrollment_id = e.id AND ep.lesson_id = l.id AND ep.completed_at IS NOT NULL
       WHERE e.user_id = ?
       GROUP BY e.id, c.id, c.title
       ORDER BY e.enrolled_at DESC
       LIMIT 3`,
      [userId],
    ),
    database.execute<RowDataPacket[]>(
      `SELECT a.id, a.title, a.due_at, c.title course_title
       FROM assignments a
       JOIN enrollments e ON e.course_id = a.course_id
       JOIN courses c ON c.id = a.course_id
       WHERE e.user_id = ?
         AND NOT EXISTS (SELECT 1 FROM assignment_submissions s WHERE s.assignment_id = a.id AND s.student_id = ?)
       ORDER BY a.due_at IS NULL, a.due_at, a.id DESC
       LIMIT 5`,
      [userId, userId],
    ),
    database.execute<RowDataPacket[]>(
      `SELECT s.id, s.assignment_id, s.score, s.feedback, s.graded_at, a.title assignment_title, c.title course_title
       FROM assignment_submissions s
       JOIN assignments a ON a.id = s.assignment_id
       JOIN courses c ON c.id = a.course_id
       WHERE s.student_id = ? AND s.score IS NOT NULL
       ORDER BY s.graded_at DESC, s.submitted_at DESC
       LIMIT 5`,
      [userId],
    ),
    database.execute<RowDataPacket[]>(
      `SELECT 'enrollment' type, c.title label, e.enrolled_at occurred_at
       FROM enrollments e
       JOIN courses c ON c.id = e.course_id
       WHERE e.user_id = ?
       UNION ALL
       SELECT 'submission' type, a.title label, s.submitted_at occurred_at
       FROM assignment_submissions s
       JOIN assignments a ON a.id = s.assignment_id
       WHERE s.student_id = ?
       UNION ALL
       SELECT 'lesson' type, l.title label, ep.completed_at occurred_at
       FROM enrollment_progress ep
       JOIN enrollments e ON e.id = ep.enrollment_id
       JOIN lessons l ON l.id = ep.lesson_id
       WHERE e.user_id = ? AND ep.completed_at IS NOT NULL
       ORDER BY occurred_at DESC
       LIMIT 5`,
      [userId, userId, userId],
    ),
  ]);
  sendSuccess(response, {
    role: "student",
    enrollments: enrollments[0],
    pendingAssignments: assignments[0],
    grades: grades[0],
    courseProgress,
    upcoming,
    recentGrades,
    recentActivity,
  });
}
