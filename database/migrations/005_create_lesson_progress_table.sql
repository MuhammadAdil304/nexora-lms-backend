CREATE TABLE IF NOT EXISTS enrollment_progress (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  enrollment_id BIGINT UNSIGNED NOT NULL,
  lesson_id BIGINT UNSIGNED NOT NULL,
  completed_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_enrollment_progress_enrollment_lesson (enrollment_id, lesson_id),
  KEY idx_enrollment_progress_lesson_id (lesson_id),
  CONSTRAINT fk_enrollment_progress_enrollment
    FOREIGN KEY (enrollment_id) REFERENCES enrollments (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT fk_enrollment_progress_lesson
    FOREIGN KEY (lesson_id) REFERENCES lessons (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);
