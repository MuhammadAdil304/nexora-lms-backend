-- User profile split: first + last name + phone (name kept as the derived
-- full name so every existing consumer keeps working). TiDB cannot validate
-- AFTER <new-column> within the same ALTER, so the columns append at the end.
ALTER TABLE users
  ADD COLUMN first_name VARCHAR(80) NULL,
  ADD COLUMN last_name VARCHAR(80) NULL,
  ADD COLUMN phone VARCHAR(24) NULL;

-- Backfill from the existing full name.
UPDATE users
SET first_name = SUBSTRING_INDEX(name, ' ', 1),
    last_name = NULLIF(SUBSTRING(name, LOCATE(' ', name) + 1), '')
WHERE first_name IS NULL;

-- Thumbnails and submission links are uploaded files converted to data-URL
-- links, which easily exceed the old VARCHAR limits.
ALTER TABLE courses MODIFY COLUMN thumbnail_url TEXT NULL;
ALTER TABLE assignment_submissions MODIFY COLUMN submission_url TEXT NULL;
