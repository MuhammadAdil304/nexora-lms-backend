import { Router } from "express";
import { getHealth } from "../controllers/health.controller";
import { getRoot } from "../controllers/root.controller";
import {
  createCourse, deleteCourse, getCourse, listCourses, updateCourse,
} from "../controllers/course.controller";
import {
  createLesson, deleteLesson, getLesson, listLessons, reorderLessons, updateLesson,
} from "../controllers/lesson.controller";
import {
  deleteEnrollment, enrollInCourse, getEnrollment, listMyEnrollments,
} from "../controllers/enrollment.controller";
import { getProgress, updateProgress } from "../controllers/progress.controller";
import {
  getCurrentUser, getUser, listUsers, login, logout, signUp, updateUserStatus, refresh, updateProfile,
} from "../controllers/user.controller";
import { getDashboardSummary } from "../controllers/dashboard.controller";
import {
  createCourseModule,
  createLessonResource,
  deleteCourseModule,
  deleteLessonResource,
  listCourseModules,
  listLessonResources,
  updateCourseModule,
  updateLessonResource,
} from "../controllers/content.controller";
import { createCategory, deleteCategory, listCategories, updateCategory } from "../controllers/category.controller";
import { addQuizQuestion, createQuiz, deleteQuiz, getQuiz, listQuizAttempts, listQuizzes, submitQuizAttempt, updateQuiz } from "../controllers/quiz.controller";
import {
  authenticate, optionalAuth, requireActiveAccount, requireActiveInstructor, requireRoles,
} from "../middleware/auth.middleware";
import { asyncHandler } from "../utils/http";
import {
  createAssignment, deleteAssignment, getAssignment, gradeSubmission, listAllSubmissions,
  listAssignments, listSubmissions, submitAssignment, updateAssignment,
} from "../controllers/assessment.controller";
import {
  deleteNotification, listMyNotifications, markAllNotificationsRead, markNotificationRead,
} from "../controllers/notification.controller";
import { globalSearch } from "../controllers/search.controller";
import { getMyGrades } from "../controllers/grade.controller";
import { createCourseReview, listCourseReviews, listMyCertificates } from "../controllers/review.controller";
import { apiLimiter, authLimiter } from "../middleware/rateLimit.middleware";

const router = Router();
const auth = [authenticate];
const activeStudent = [authenticate, requireRoles("student"), requireActiveAccount];
const instructor = [authenticate, requireRoles("instructor", "admin"), requireActiveInstructor];
const admin = [authenticate, requireRoles("admin"), requireActiveAccount];
const optional = [optionalAuth];

router.get("/", getRoot);
router.get("/health", asyncHandler(getHealth));

// Authentication - HttpOnly cookie access/refresh token flow.
router.post("/auth/signup", authLimiter, asyncHandler(signUp));
router.post("/auth/login", authLimiter, asyncHandler(login));
router.post("/auth/logout", asyncHandler(logout));
router.post("/auth/refresh", authLimiter, asyncHandler(refresh));
router.get("/auth/me", auth, asyncHandler(getCurrentUser));

// Users and administrator account approval.
router.use("/", apiLimiter); // general API rate limit for everything below
router.get("/users/me", auth, asyncHandler(getCurrentUser));
router.patch("/users/me", auth, asyncHandler(updateProfile));
router.get("/users", instructor, asyncHandler(listUsers));
router.get("/users/:id", instructor, asyncHandler(getUser));
router.patch("/users/:id/status", admin, asyncHandler(updateUserStatus));

router.get("/dashboard/summary", auth, asyncHandler(getDashboardSummary));

// Notifications (in-app bell + notifications page).
router.get("/notifications", auth, asyncHandler(listMyNotifications));
router.patch("/notifications/read-all", auth, asyncHandler(markAllNotificationsRead));
router.patch("/notifications/:id/read", auth, asyncHandler(markNotificationRead));
router.delete("/notifications/:id", auth, asyncHandler(deleteNotification));

// Global workspace search (navbar search box).
router.get("/search", auth, asyncHandler(globalSearch));

// Combined student grades (assignments + quizzes).
router.get("/grades/me", activeStudent, asyncHandler(getMyGrades));

// Certificates earned by the calling student.
router.get("/certificates", auth, asyncHandler(listMyCertificates));

router.get("/categories", asyncHandler(listCategories));
router.post("/categories", admin, asyncHandler(createCategory));
router.patch("/categories/:id", admin, asyncHandler(updateCategory));
router.delete("/categories/:id", admin, asyncHandler(deleteCategory));

// Courses. Public readers only see published courses.
router.get("/courses", optional, asyncHandler(listCourses));
router.get("/courses/:id", optional, asyncHandler(getCourse));
router.get("/courses/:id/reviews", asyncHandler(listCourseReviews));
router.post("/courses/:id/reviews", activeStudent, asyncHandler(createCourseReview));
router.post("/courses", instructor, asyncHandler(createCourse));
router.patch("/courses/:id", instructor, asyncHandler(updateCourse));
router.put("/courses/:id", instructor, asyncHandler(updateCourse));
router.delete("/courses/:id", instructor, asyncHandler(deleteCourse));

// Lessons are owned by the course instructor (or an admin).
router.get("/courses/:courseId/lessons", optional, asyncHandler(listLessons));
router.post("/courses/:courseId/lessons", instructor, asyncHandler(createLesson));
router.patch("/courses/:courseId/lessons/reorder", instructor, asyncHandler(reorderLessons));
router.put("/courses/:courseId/lessons/reorder", instructor, asyncHandler(reorderLessons));
router.get("/lessons/:id", optional, asyncHandler(getLesson));
router.patch("/lessons/:id", instructor, asyncHandler(updateLesson));
router.put("/lessons/:id", instructor, asyncHandler(updateLesson));
router.delete("/lessons/:id", instructor, asyncHandler(deleteLesson));

router.get("/courses/:courseId/modules", optional, asyncHandler(listCourseModules));
router.post("/courses/:courseId/modules", instructor, asyncHandler(createCourseModule));
router.patch("/modules/:moduleId", instructor, asyncHandler(updateCourseModule));
router.delete("/modules/:moduleId", instructor, asyncHandler(deleteCourseModule));
router.get("/lessons/:lessonId/resources", optional, asyncHandler(listLessonResources));
router.post("/lessons/:lessonId/resources", instructor, asyncHandler(createLessonResource));
router.patch("/resources/:resourceId", instructor, asyncHandler(updateLessonResource));
router.delete("/resources/:resourceId", instructor, asyncHandler(deleteLessonResource));

// Student enrollment.
router.post("/courses/:courseId/enroll", activeStudent, asyncHandler(enrollInCourse));
router.post("/enrollments", activeStudent, asyncHandler(enrollInCourse));
router.get("/enrollments", auth, asyncHandler(listMyEnrollments));
router.get("/enrollments/:id", auth, asyncHandler(getEnrollment));
router.delete("/enrollments/:id", auth, asyncHandler(deleteEnrollment));

// Assessments support the assignment, submission, and grading flows shown in the LMS workspace.
router.get("/assignments", auth, asyncHandler(listAssignments));
router.get("/assignments/:assignmentId", auth, asyncHandler(getAssignment));
router.get("/courses/:courseId/assignments", asyncHandler(listAssignments));
router.post("/courses/:courseId/assignments", instructor, asyncHandler(createAssignment));
router.patch("/assignments/:assignmentId", instructor, asyncHandler(updateAssignment));
router.delete("/assignments/:assignmentId", instructor, asyncHandler(deleteAssignment));
router.get("/assignments/:assignmentId/submissions", instructor, asyncHandler(listSubmissions));
router.post("/assignments/:assignmentId/submissions", activeStudent, asyncHandler(submitAssignment));
router.get("/submissions", auth, asyncHandler(listAllSubmissions));
router.patch("/submissions/:submissionId/grade", instructor, asyncHandler(gradeSubmission));

router.get("/quizzes", auth, asyncHandler(listQuizzes));
router.get("/courses/:courseId/quizzes", auth, asyncHandler(listQuizzes));
router.get("/quizzes/:id", auth, asyncHandler(getQuiz));
router.post("/courses/:courseId/quizzes", instructor, asyncHandler(createQuiz));
router.patch("/quizzes/:id", instructor, asyncHandler(updateQuiz));
router.delete("/quizzes/:id", instructor, asyncHandler(deleteQuiz));
router.post("/quizzes/:id/questions", instructor, asyncHandler(addQuizQuestion));
router.post("/quizzes/:id/attempts", activeStudent, asyncHandler(submitQuizAttempt));
router.get("/quizzes/:id/attempts", auth, asyncHandler(listQuizAttempts));

// Progress is scoped to an enrollment and can be read by the student or course owner.
router.get("/enrollments/:enrollmentId/progress", auth, asyncHandler(getProgress));
router.patch("/enrollments/:enrollmentId/progress/:lessonId", auth, asyncHandler(updateProgress));

export default router;
