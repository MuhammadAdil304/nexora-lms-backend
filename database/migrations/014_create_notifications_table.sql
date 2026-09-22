-- Notifications shown in the workspace bell menu (per nexora-lms.html design)
CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  type ENUM('enrollment', 'grade', 'quiz', 'account', 'completion', 'system')
    NOT NULL DEFAULT 'system',
  title VARCHAR(200) NOT NULL,
  body TEXT NULL,
  link VARCHAR(255) NULL,
  read_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_notifications_user_created (user_id, created_at),
  KEY idx_notifications_unread (user_id, read_at),
  CONSTRAINT fk_notifications_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);
