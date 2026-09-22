-- Instructor-configurable retake allowance. Total attempts a student gets is
-- 1 + allowed_retakes (0 means a single attempt with no retakes).
ALTER TABLE quizzes
  ADD COLUMN allowed_retakes INT UNSIGNED NOT NULL DEFAULT 0;
