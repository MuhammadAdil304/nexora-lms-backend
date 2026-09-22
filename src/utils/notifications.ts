import { ResultSetHeader, RowDataPacket } from "mysql2";
import { database } from "../config/database";
import { logger } from "./logger";

export type NotificationType =
  | "enrollment"
  | "grade"
  | "quiz"
  | "account"
  | "completion"
  | "system";

/**
 * Best-effort notification insert. Notification failures must never break
 * the primary business flow that triggered them.
 */
export async function notify(
  userId: number,
  type: NotificationType,
  title: string,
  body?: string | null,
  link?: string | null,
): Promise<void> {
  try {
    await database.execute<ResultSetHeader>(
      "INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)",
      [userId, type, title, body ?? null, link ?? null],
    );
  } catch (err) {
    logger.warn({ err, userId, type }, "Failed to create notification");
  }
}

/** Notify every active student enrolled in a course. */
export async function notifyCourseStudents(
  courseId: number,
  type: NotificationType,
  title: string,
  body?: string | null,
  link?: string | null,
): Promise<void> {
  try {
    const [rows] = await database.execute<(RowDataPacket & { user_id: number })[]>(
      "SELECT user_id FROM enrollments WHERE course_id = ?",
      [courseId],
    );
    await Promise.all(rows.map((row) => notify(Number(row.user_id), type, title, body, link)));
  } catch (err) {
    logger.warn({ err, courseId, type }, "Failed to notify course students");
  }
}
