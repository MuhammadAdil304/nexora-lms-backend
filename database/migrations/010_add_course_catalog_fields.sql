ALTER TABLE courses
  ADD COLUMN level ENUM('beginner', 'intermediate', 'advanced') NOT NULL DEFAULT 'beginner',
  ADD COLUMN duration VARCHAR(100) NULL,
  ADD COLUMN learning_outcomes TEXT NULL,
  ADD COLUMN thumbnail_url VARCHAR(500) NULL;
