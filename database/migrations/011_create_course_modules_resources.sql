CREATE TABLE IF NOT EXISTS course_modules (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  course_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT NULL,
  position INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_course_modules_course_id (course_id),
  UNIQUE KEY uq_course_modules_course_position (course_id, position),
  CONSTRAINT fk_course_modules_course
    FOREIGN KEY (course_id) REFERENCES courses (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

ALTER TABLE lessons
  ADD COLUMN module_id BIGINT UNSIGNED NULL AFTER course_id;

ALTER TABLE lessons
  ADD KEY idx_lessons_module_id (module_id);

ALTER TABLE lessons
  ADD CONSTRAINT fk_lessons_module
    FOREIGN KEY (module_id) REFERENCES course_modules (id)
    ON DELETE SET NULL
    ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS lesson_resources (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  lesson_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(200) NOT NULL,
  resource_type ENUM('link', 'file', 'video', 'reading') NOT NULL DEFAULT 'link',
  url VARCHAR(500) NULL,
  description TEXT NULL,
  position INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_lesson_resources_lesson_id (lesson_id),
  CONSTRAINT fk_lesson_resources_lesson
    FOREIGN KEY (lesson_id) REFERENCES lessons (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);
