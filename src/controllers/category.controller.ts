import { Request, Response } from "express";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import { database } from "../config/database";
import { AppError, parsePositiveId, sendSuccess } from "../utils/http";

interface CategoryRow extends RowDataPacket {
  id: number;
  name: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapCategory(row: CategoryRow) {
  return { id: Number(row.id), name: row.name, description: row.description, createdAt: row.created_at, updatedAt: row.updated_at };
}

function categoryInput(body: unknown) {
  const value = (body ?? {}) as Record<string, unknown>;
  const name = typeof value.name === "string" ? value.name.trim() : undefined;
  const description = value.description === null ? null : typeof value.description === "string" ? value.description.trim() : undefined;
  if (name !== undefined && !name) throw new AppError("name cannot be empty", 400, "VALIDATION_ERROR");
  return { name, description };
}

export async function listCategories(_request: Request, response: Response) {
  const [rows] = await database.execute<CategoryRow[]>("SELECT * FROM categories ORDER BY name");
  sendSuccess(response, rows.map(mapCategory));
}

export async function createCategory(request: Request, response: Response) {
  const { name, description } = categoryInput(request.body);
  if (!name) throw new AppError("name is required", 400, "VALIDATION_ERROR");
  try {
    const [result] = await database.execute<ResultSetHeader>("INSERT INTO categories (name, description) VALUES (?, ?)", [name, description ?? null]);
    const [rows] = await database.execute<CategoryRow[]>("SELECT * FROM categories WHERE id = ?", [result.insertId]);
    sendSuccess(response, mapCategory(rows[0]), 201, "Category created");
  } catch (error) {
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") throw new AppError("Category name already exists", 409, "CATEGORY_EXISTS");
    throw error;
  }
}

export async function updateCategory(request: Request, response: Response) {
  const id = parsePositiveId(request.params.id, "category id");
  const { name, description } = categoryInput(request.body);
  if (name === undefined && description === undefined) throw new AppError("At least one field is required", 400, "VALIDATION_ERROR");
  const updates: string[] = [];
  const values: Array<string | number | null> = [];
  if (name !== undefined) { updates.push("name = ?"); values.push(name); }
  if (description !== undefined) { updates.push("description = ?"); values.push(description); }
  values.push(id);
  const [result] = await database.execute<ResultSetHeader>(`UPDATE categories SET ${updates.join(", ")} WHERE id = ?`, values);
  if (!result.affectedRows) throw new AppError("Category not found", 404, "NOT_FOUND");
  const [rows] = await database.execute<CategoryRow[]>("SELECT * FROM categories WHERE id = ?", [id]);
  sendSuccess(response, mapCategory(rows[0]));
}

export async function deleteCategory(request: Request, response: Response) {
  const id = parsePositiveId(request.params.id, "category id");
  const [result] = await database.execute<ResultSetHeader>("DELETE FROM categories WHERE id = ?", [id]);
  if (!result.affectedRows) throw new AppError("Category not found", 404, "NOT_FOUND");
  sendSuccess(response, null, 200, "Category deleted");
}
