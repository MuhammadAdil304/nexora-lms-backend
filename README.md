# LMS backend

Express + TypeScript API using raw parameterized `mysql2` queries. No passwords
are returned by any endpoint. Copy `.env.example` to `.env`, configure MySQL,
and execute the migrations in `database/migrations` in numeric order.

```bash
npm install
npm run build
npm start
```

## Authentication and roles

`POST /auth/signup` accepts `name` (or the legacy `username`), `email`,
`password`, and an optional `role` of `student` or `instructor`. Public admin
signup is rejected. Students are `active`; instructors start as `pending`.
An administrator can approve an instructor with
`PATCH /users/:id/status` and `{ "status": "active" }`.

`POST /auth/login` returns a JWT. Send it as `Authorization: Bearer <token>`.
Only active instructors (and administrators) can create, update, delete, or
reorder courses and lessons.

## API overview

| Method | Endpoint | Access |
| --- | --- | --- |
| POST | `/auth/signup`, `/auth/login` | Public |
| GET | `/users/me` | Authenticated |
| GET | `/users` | Admin |
| PATCH | `/users/:id/status` | Admin |
| GET | `/courses`, `/courses/:id` | Public (published only) |
| POST | `/courses` | Active instructor/admin |
| PATCH/DELETE | `/courses/:id` | Course owner/admin |
| GET | `/courses/:courseId/lessons` | Public (published only) |
| POST | `/courses/:courseId/lessons` | Course owner/admin |
| PATCH/DELETE | `/lessons/:id` | Course owner/admin |
| PATCH | `/courses/:courseId/lessons/reorder` | Course owner/admin |
| POST | `/courses/:courseId/enroll` | Active student |
| GET | `/enrollments`, `/enrollments/:id` | Authenticated |
| DELETE | `/enrollments/:id` | Enrolled student/admin |
| GET | `/enrollments/:enrollmentId/progress` | Student/course owner/admin |
| PATCH | `/enrollments/:enrollmentId/progress/:lessonId` | Enrolled student |
| GET | `/courses/:courseId/assignments` | Authenticated |
| POST | `/courses/:courseId/assignments` | Course owner/admin |
| POST | `/assignments/:assignmentId/submissions` | Active student |
| GET | `/assignments/:assignmentId/submissions` | Course owner/admin |
| PATCH | `/submissions/:submissionId/grade` | Course owner/admin |

Responses use `{ "success": true, "data": ... }`; errors use
`{ "success": false, "error": { "code": "...", "message": "..." } }`.

## Insomnia examples

Create a student:

```http
POST {{ _.base_url }}/auth/signup
Content-Type: application/json

{ "name": "Ada Student", "email": "ada@example.com", "password": "password123" }
```

Create an instructor (starts pending), then approve the user as an admin:

```http
POST {{ _.base_url }}/auth/signup
Content-Type: application/json

{ "name": "Grace Instructor", "email": "grace@example.com",
  "password": "password123", "role": "instructor" }
```

```http
PATCH {{ _.base_url }}/users/2/status
Authorization: Bearer {{ _.admin_token }}
Content-Type: application/json

{ "status": "active" }
```

Create and publish a course:

```http
POST {{ _.base_url }}/courses
Authorization: Bearer {{ _.instructor_token }}
Content-Type: application/json

{ "title": "SQL Fundamentals", "description": "Learn SQL",
  "status": "published" }
```

Enroll and mark a lesson complete:

```http
POST {{ _.base_url }}/courses/1/enroll
Authorization: Bearer {{ _.student_token }}

PATCH {{ _.base_url }}/enrollments/1/progress/1
Authorization: Bearer {{ _.student_token }}
Content-Type: application/json

{ "completed": true }
```

## Assessments

Run migration `008_create_assessments_tables.sql` after the existing migrations.
An instructor can create an assignment for a course:

```http
POST {{ _.base_url }}/courses/1/assignments
Authorization: Bearer {{ _.instructor_token }}
Content-Type: application/json

{
  "title": "DOM Mini Project",
  "description": "Build a small interactive page.",
  "dueAt": "2026-09-25 23:59:00",
  "maxScore": 100
}
```

Students submit work with `submissionUrl` and an optional comment. Course owners
can list submissions and grade them. Quizzes, certificates, notifications, and
analytics are currently presentation-only sections in `nexora-lms.html`; they
should be added as separate modules when their storage and grading rules are
defined rather than returning fabricated dashboard values.
