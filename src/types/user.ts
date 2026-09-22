export type UserRole = "student" | "instructor" | "admin";
export type UserStatus = "active" | "pending" | "suspended";

export interface AuthenticatedUser {
  id: number;
  name: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  email: string;
  role: UserRole;
  status: UserStatus;
}
