CREATE TABLE IF NOT EXISTS companies(id TEXT PRIMARY KEY,name TEXT NOT NULL,daily_calls INTEGER NOT NULL DEFAULT 100,daily_tokens INTEGER NOT NULL DEFAULT 1000000,consent_version TEXT NOT NULL DEFAULT '2026-10-v1');
   CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','consultant')),enabled INTEGER NOT NULL DEFAULT 1,password_hash TEXT NOT NULL,created_at TEXT NOT NULL,must_change INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires BIGINT NOT NULL,touched BIGINT NOT NULL);
   CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),owner_id TEXT NOT NULL REFERENCES users(id),revision INTEGER NOT NULL DEFAULT 1,payload TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),owner_id TEXT NOT NULL REFERENCES users(id),job_id TEXT NOT NULL REFERENCES jobs(id),status TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),user_id TEXT NOT NULL REFERENCES users(id),day TEXT NOT NULL,reserved INTEGER NOT NULL,tokens INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS audits(id TEXT PRIMARY KEY,company_id TEXT NOT NULL,user_id TEXT,action TEXT NOT NULL,target TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY,failures INTEGER NOT NULL,until_time BIGINT NOT NULL);
   
CREATE INDEX jobs_company_owner ON jobs(company_id,owner_id);
CREATE INDEX tasks_queue ON tasks(status,created_at);
CREATE INDEX usage_daily ON usage(company_id,day);
CREATE TABLE worker_dispatch(id INTEGER PRIMARY KEY,last_trigger BIGINT NOT NULL DEFAULT 0);
INSERT INTO worker_dispatch(id) VALUES(1);
