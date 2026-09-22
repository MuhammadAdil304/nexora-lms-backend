-- Lesson media/content typing required by the learning player view
ALTER TABLE lessons
  ADD COLUMN content_type ENUM('text', 'video', 'article') NOT NULL DEFAULT 'text',
  ADD COLUMN video_url VARCHAR(500) NULL,
  ADD COLUMN duration_minutes INT UNSIGNED NULL;
