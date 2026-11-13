CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL,
  name TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  source TEXT NOT NULL,
  title TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  start_observed INTEGER NOT NULL,
  branch TEXT NOT NULL DEFAULT ''
);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  document_json TEXT NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE TABLE blobs (
  hash TEXT PRIMARY KEY,
  content TEXT NOT NULL
);
CREATE TABLE changes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  summary TEXT NOT NULL,
  delta_json TEXT NOT NULL,
  model_after_json TEXT NOT NULL,
  document_json TEXT NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE TABLE change_files (
  change_id TEXT NOT NULL REFERENCES changes(id),
  path TEXT NOT NULL,
  before_hash TEXT REFERENCES blobs(hash),
  after_hash TEXT REFERENCES blobs(hash),
  added INTEGER NOT NULL,
  deleted INTEGER NOT NULL,
  PRIMARY KEY(change_id, path)
);
CREATE TABLE session_files (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  path TEXT NOT NULL,
  hash TEXT NOT NULL REFERENCES blobs(hash),
  PRIMARY KEY(session_id, path)
);
CREATE TABLE pending_files (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  tool_call_id TEXT NOT NULL,
  path TEXT NOT NULL,
  hash TEXT REFERENCES blobs(hash),
  PRIMARY KEY(session_id, tool_call_id, path)
);