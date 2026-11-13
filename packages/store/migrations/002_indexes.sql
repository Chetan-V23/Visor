CREATE INDEX sessions_started_at ON sessions(started_at DESC);
CREATE INDEX changes_session_history ON changes(session_id, seq DESC);
CREATE INDEX events_session_order ON events(session_id, seq);