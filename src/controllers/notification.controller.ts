import { Request, Response } from "express";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import { database } from "../config/database";
import { AppError, parsePositiveId, sendSuccess } from "../utils/http";

interface NotificationRow extends RowDataPacket {
  id: number;
  user_id: number;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: Date | null;
  created_at: Date;
}

function mapNotification(row: NotificationRow) {
  return {
    id: Number(row.id),
    type: row.type,
    title: row.title,
    body: row.body,
    link: row.link,
    read: row.read_at !== null,
    createdAt: row.created_at,
  };
}

function pagination(request: Request): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(request.query.limit ?? 20) || 20, 1), 100) | 0;
  const page = Math.max(Number(request.query.page ?? 1) || 1, 1) | 0;
  return { limit, offset: (page - 1) * limit };
}

export async function listMyNotifications(request: Request, response: Response): Promise<void> {
  const { limit, offset } = pagination(request);
  const userId = request.user?.id ?? 0;
  const unreadOnly = String(request.query.unread ?? "") === "true";
  // LIMIT/OFFSET are interpolated as validated integers: TiDB's prepared
  // statement protocol rejects placeholder parameters for these clauses.
  const [rows] = await database.execute<NotificationRow[]>(
    `SELECT * FROM notifications WHERE user_id = ?${unreadOnly ? " AND read_at IS NULL" : ""}
     ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
    [userId],
  );
  const [[countRow], [unreadRow]] = await Promise.all([
    database.execute<RowDataPacket[]>("SELECT COUNT(*) total FROM notifications WHERE user_id = ?", [userId]),
    database.execute<RowDataPacket[]>("SELECT COUNT(*) total FROM notifications WHERE user_id = ? AND read_at IS NULL", [userId]),
  ]);
  sendSuccess(response, {
    notifications: rows.map(mapNotification),
    unreadCount: Number(unreadRow[0]?.total ?? 0),
    total: Number(countRow[0]?.total ?? 0),
    limit,
    offset,
  });
}

export async function markNotificationRead(request: Request, response: Response): Promise<void> {
  const id = parsePositiveId(request.params.id, "notification id");
  const [result] = await database.execute<ResultSetHeader>(
    "UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND read_at IS NULL",
    [id, request.user?.id ?? 0],
  );
  if (!result.affectedRows) {
    // Could be already read or not owned — verify ownership before 404.
    const [rows] = await database.execute<RowDataPacket[]>(
      "SELECT id FROM notifications WHERE id = ? AND user_id = ? LIMIT 1",
      [id, request.user?.id ?? 0],
    );
    if (!rows[0]) throw new AppError("Notification not found", 404, "NOT_FOUND");
  }
  sendSuccess(response, null, 200, "Notification marked as read");
}

export async function markAllNotificationsRead(request: Request, response: Response): Promise<void> {
  const [result] = await database.execute<ResultSetHeader>(
    "UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND read_at IS NULL",
    [request.user?.id ?? 0],
  );
  sendSuccess(response, { marked: result.affectedRows }, 200, "All notifications marked as read");
}

export async function deleteNotification(request: Request, response: Response): Promise<void> {
  const id = parsePositiveId(request.params.id, "notification id");
  const [result] = await database.execute<ResultSetHeader>(
    "DELETE FROM notifications WHERE id = ? AND user_id = ?",
    [id, request.user?.id ?? 0],
  );
  if (!result.affectedRows) throw new AppError("Notification not found", 404, "NOT_FOUND");
  sendSuccess(response, null, 200, "Notification deleted");
}
