ALTER TABLE presence_notifications
ADD COLUMN IF NOT EXISTS grade_reason TEXT DEFAULT NULL;
