-- High-traffic dashboard/list and availability indexes
-- NOTE: run during low-traffic deployment window.

CREATE INDEX idx_notifications_user_read_created
  ON notifications (user_id, is_read, created_at);

CREATE INDEX idx_lesson_sessions_student_status_starts
  ON lesson_sessions (student_id, status, starts_at);

CREATE INDEX idx_lesson_sessions_teacher_status_starts_ends
  ON lesson_sessions (teacher_id, status, starts_at, ends_at);

CREATE INDEX idx_parent_change_requests_parent_created_status
  ON parent_change_requests (parent_id, created_at, status);

CREATE INDEX idx_teacher_schedule_exceptions_teacher_date_active_window
  ON teacher_schedule_exceptions (teacher_id, exception_date, is_active, start_time, end_time);

CREATE INDEX idx_lesson_session_students_session_id
  ON lesson_session_students (session_id);
