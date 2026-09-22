import { Request, Response } from "express";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import { database } from "../config/database";
import { AppError, parsePositiveId, sendSuccess } from "../utils/http";

interface ModuleRow extends RowDataPacket {
  id: number;
  course_id: number;
  title: string;
  description: string | null;
  position: number;
}

interface ResourceRow extends RowDataPacket {
  id: number;
  lesson_id: number;
  title: string;
  resource_type: "link" | "file" | "video" | "reading";
  url: string | null;
  description: string | null;
  position: number;
}

function mapModule(row: ModuleRow) {
  return {
    id: Number(row.id),
    courseId: Number(row.course_id),
    title: row.title,
    description: row.description,
    position: Number(row.position),
  };
}

function mapResource(row: ResourceRow) {
  return {
    id: Number(row.id),
    lessonId: Number(row.lesson_id),
    title: row.title,
    resourceType: row.resource_type,
    url: row.url,
    description: row.description,
    position: Number(row.position),
  };
}

async function courseAccess(request: Request, courseId: number) {
  const [rows] = await database.execute<RowDataPacket[]>(
    "SELECT id, instructor_id, status FROM courses WHERE id = ? LIMIT 1",
    [courseId],
  );
  const course = rows[0];
  if (!course) throw new AppError("Course not found", 404, "NOT_FOUND");
  const isOwner = request.user?.role === "admin" || Number(course.instructor_id) === request.user?.id;
  if (course.status !== "published" && !isOwner) {
    throw new AppError("Course not found", 404, "NOT_FOUND");
  }
  return { course, isOwner };
}

async function assertCourseOwner(request: Request, courseId: number) {
  const access = await courseAccess(request, courseId);
  if (!access.isOwner) throw new AppError("You do not own this course", 403, "FORBIDDEN");
}

async function canAccessCourseContent(request: Request, courseId: number, instructorId: number) {
  if (request.user?.role === "admin" || request.user?.id === instructorId) return true;
  if (!request.user || request.user.role !== "student") return false;
  const [rows] = await database.execute<RowDataPacket[]>(
    "SELECT id FROM enrollments WHERE course_id = ? AND user_id = ? LIMIT 1",
    [courseId, request.user.id],
  );
  return Boolean(rows[0]);
}

async function lessonCourseId(lessonId: number) {
  const [rows] = await database.execute<RowDataPacket[]>(
    "SELECT course_id FROM lessons WHERE id = ? LIMIT 1",
    [lessonId],
  );
  if (!rows[0]) throw new AppError("Lesson not found", 404, "NOT_FOUND");
  return Number(rows[0].course_id);
}

export async function listCourseModules(request: Request, response: Response) {
  const courseId = parsePositiveId(request.params.courseId, "course id");
  await courseAccess(request, courseId);
  const [modules] = await database.execute<ModuleRow[]>(
    "SELECT * FROM course_modules WHERE course_id = ? ORDER BY position, id",
    [courseId],
  );
  sendSuccess(response, modules.map(mapModule));
}

export async function createCourseModule(request: Request, response: Response) {
  const courseId = parsePositiveId(request.params.courseId, "course id");
  await assertCourseOwner(request, courseId);
  const body = (request.body ?? {}) as Record<string, unknown>;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) throw new AppError("title is required", 400, "VALIDATION_ERROR");
  const description = typeof body.description === "string" ? body.description.trim() : null;
  const position = typeof body.position === "number" && body.position > 0 ? Math.floor(body.position) : 1;
  const [result] = await database.execute<ResultSetHeader>(
    "INSERT INTO course_modules (course_id, title, description, position) VALUES (?, ?, ?, ?)",
    [courseId, title, description, position],
  );
  const [rows] = await database.execute<ModuleRow[]>("SELECT * FROM course_modules WHERE id = ?", [result.insertId]);
  sendSuccess(response, mapModule(rows[0]), 201, "Module created");
}

export async function updateCourseModule(request: Request, response: Response) {
  const moduleId = parsePositiveId(request.params.moduleId, "module id");
  const [modules] = await database.execute<ModuleRow[]>("SELECT * FROM course_modules WHERE id = ? LIMIT 1", [moduleId]);
  const module = modules[0];
  if (!module) throw new AppError("Module not found", 404, "NOT_FOUND");
  await assertCourseOwner(request, Number(module.course_id));
  const body = (request.body ?? {}) as Record<string, unknown>;
  const updates: string[] = [];
  const values: Array<string | number | null> = [];
  if (body.title !== undefined) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) throw new AppError("title cannot be empty", 400, "VALIDATION_ERROR");
    updates.push("title = ?");
    values.push(title);
  }
  if (body.description !== undefined) {
    updates.push("description = ?");
    values.push(typeof body.description === "string" ? body.description.trim() : null);
  }
  if (body.position !== undefined) {
    const position = typeof body.position === "number" ? Math.floor(body.position) : NaN;
    if (!Number.isSafeInteger(position) || position < 1) throw new AppError("position must be a positive integer", 400, "VALIDATION_ERROR");
    updates.push("position = ?");
    values.push(position);
  }
  if (!updates.length) throw new AppError("At least one field is required", 400, "VALIDATION_ERROR");
  values.push(moduleId);
  await database.execute(`UPDATE course_modules SET ${updates.join(", ")} WHERE id = ?`, values);
  const [rows] = await database.execute<ModuleRow[]>("SELECT * FROM course_modules WHERE id = ?", [moduleId]);
  sendSuccess(response, mapModule(rows[0]));
}

export async function deleteCourseModule(request: Request, response: Response) {
  const moduleId = parsePositiveId(request.params.moduleId, "module id");
  const [modules] = await database.execute<ModuleRow[]>("SELECT * FROM course_modules WHERE id = ? LIMIT 1", [moduleId]);
  const module = modules[0];
  if (!module) throw new AppError("Module not found", 404, "NOT_FOUND");
  await assertCourseOwner(request, Number(module.course_id));
  await database.execute("DELETE FROM course_modules WHERE id = ?", [moduleId]);
  sendSuccess(response, null, 200, "Module deleted");
}

export async function listLessonResources(request: Request, response: Response) {
  const lessonId = parsePositiveId(request.params.lessonId, "lesson id");
  const courseId = await lessonCourseId(lessonId);
  const access = await courseAccess(request, courseId);
  if (!await canAccessCourseContent(request, courseId, Number(access.course.instructor_id))) {
    throw new AppError("Enroll in the course to view lesson resources", 403, "ENROLLMENT_REQUIRED");
  }
  const [resources] = await database.execute<ResourceRow[]>(
    "SELECT * FROM lesson_resources WHERE lesson_id = ? ORDER BY position, id",
    [lessonId],
  );
  sendSuccess(response, resources.map(mapResource));
}

export async function createLessonResource(request: Request, response: Response) {
  const lessonId = parsePositiveId(request.params.lessonId, "lesson id");
  const courseId = await lessonCourseId(lessonId);
  await assertCourseOwner(request, courseId);
  const body = (request.body ?? {}) as Record<string, unknown>;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) throw new AppError("title is required", 400, "VALIDATION_ERROR");
  const resourceType = String(body.resourceType ?? "link");
  if (!["link", "file", "video", "reading"].includes(resourceType)) {
    throw new AppError("resourceType must be link, file, video, or reading", 400, "VALIDATION_ERROR");
  }
  const url = typeof body.url === "string" ? body.url.trim() : null;
  const description = typeof body.description === "string" ? body.description.trim() : null;
  const position = typeof body.position === "number" && body.position > 0 ? Math.floor(body.position) : 1;
  const [result] = await database.execute<ResultSetHeader>(
    "INSERT INTO lesson_resources (lesson_id, title, resource_type, url, description, position) VALUES (?, ?, ?, ?, ?, ?)",
    [lessonId, title, resourceType, url, description, position],
  );
  const [rows] = await database.execute<ResourceRow[]>("SELECT * FROM lesson_resources WHERE id = ?", [result.insertId]);
  sendSuccess(response, mapResource(rows[0]), 201, "Resource created");
}

export async function updateLessonResource(request: Request, response: Response) {
  const resourceId = parsePositiveId(request.params.resourceId, "resource id");
  const [resources] = await database.execute<ResourceRow[]>("SELECT * FROM lesson_resources WHERE id = ? LIMIT 1", [resourceId]);
  const resource = resources[0];
  if (!resource) throw new AppError("Resource not found", 404, "NOT_FOUND");
  const courseId = await lessonCourseId(Number(resource.lesson_id));
  await assertCourseOwner(request, courseId);
  const body = (request.body ?? {}) as Record<string, unknown>;
  const updates: string[] = [];
  const values: Array<string | number | null> = [];
  if (body.title !== undefined) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) throw new AppError("title cannot be empty", 400, "VALIDATION_ERROR");
    updates.push("title = ?");
    values.push(title);
  }
  if (body.resourceType !== undefined) {
    const resourceType = String(body.resourceType);
    if (!["link", "file", "video", "reading"].includes(resourceType)) throw new AppError("resourceType must be link, file, video, or reading", 400, "VALIDATION_ERROR");
    updates.push("resource_type = ?");
    values.push(resourceType);
  }
  if (body.url !== undefined) {
    updates.push("url = ?");
    values.push(typeof body.url === "string" ? body.url.trim() : null);
  }
  if (body.description !== undefined) {
    updates.push("description = ?");
    values.push(typeof body.description === "string" ? body.description.trim() : null);
  }
  if (body.position !== undefined) {
    const position = typeof body.position === "number" ? Math.floor(body.position) : NaN;
    if (!Number.isSafeInteger(position) || position < 1) throw new AppError("position must be a positive integer", 400, "VALIDATION_ERROR");
    updates.push("position = ?");
    values.push(position);
  }
  if (!updates.length) throw new AppError("At least one field is required", 400, "VALIDATION_ERROR");
  values.push(resourceId);
  await database.execute(`UPDATE lesson_resources SET ${updates.join(", ")} WHERE id = ?`, values);
  const [rows] = await database.execute<ResourceRow[]>("SELECT * FROM lesson_resources WHERE id = ?", [resourceId]);
  sendSuccess(response, mapResource(rows[0]));
}

export async function deleteLessonResource(request: Request, response: Response) {
  const resourceId = parsePositiveId(request.params.resourceId, "resource id");
  const [resources] = await database.execute<ResourceRow[]>("SELECT * FROM lesson_resources WHERE id = ? LIMIT 1", [resourceId]);
  const resource = resources[0];
  if (!resource) throw new AppError("Resource not found", 404, "NOT_FOUND");
  const courseId = await lessonCourseId(Number(resource.lesson_id));
  await assertCourseOwner(request, courseId);
  await database.execute("DELETE FROM lesson_resources WHERE id = ?", [resourceId]);
  sendSuccess(response, null, 200, "Resource deleted");
}
