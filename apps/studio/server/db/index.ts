// The app database (bun:sqlite). Metadata only; content lives in DATA_DIR (CLAUDE.md Stack).
// Migrations run in order, each once, tracked by user_version.
import { Database } from 'bun:sqlite'

const MIGRATIONS: string[] = [
  `
  create table users (
    id integer primary key,
    handle text not null unique check (handle glob '[a-z]*' and handle not glob '*[^a-z]*'),
    name text not null,
    role text not null check (role in ('admin', 'creator')),
    password_hash text,
    language text not null default 'en' check (language in ('en', 'da')),
    created_at text not null
  );
  create table sessions (
    id text primary key,
    user_id integer not null references users(id),
    csrf text not null,
    created_at integer not null,
    last_seen integer not null
  );
  create table projects (
    id text primary key check (id glob '[a-z0-9]*' and id not glob '*[^a-z0-9]*'),
    name text not null,
    home text not null,
    approved text,
    archived text not null default '[]',
    next_artboard text not null default 'a',
    created_at text not null
  );
  create table members (
    project_id text not null references projects(id),
    user_id integer not null references users(id),
    primary key (project_id, user_id)
  );
  create table drafts (
    id integer primary key,
    project_id text not null references projects(id),
    user_id integer not null references users(id),
    base text,
    files text not null default '{}',
    updated_at text not null,
    unique (project_id, user_id)
  );
  create table versions (
    id integer primary key,
    draft_id integer not null references drafts(id),
    files text not null,
    at text not null
  );
  create table usage (
    id integer primary key,
    call_id text not null,
    attempt integer not null,
    status text not null,
    error text,
    project text, phase text, action text, task_class text, user text, revision text,
    provider text, endpoint text, model text, model_role text,
    input_tokens integer, output_tokens integer, cached_tokens integer,
    latency_ms integer, retries integer, valid_first_try integer,
    outcome text not null default 'pending',
    estimated integer not null default 0,
    at text not null
  );
  `,
  `
  create table passkeys (
    id text primary key,
    user_id integer not null references users(id),
    public_key text not null,
    alg integer not null,
    sign_count integer not null default 0,
    created_at text not null
  );
  create table setup_codes (
    user_id integer primary key references users(id),
    code_hash text not null,
    expires_at integer not null,
    used_at integer
  );
  create table challenges (
    id text primary key,
    kind text not null check (kind in ('setup', 'sign-in')),
    user_id integer references users(id),
    challenge text not null,
    expires_at integer not null
  );
  `,
  `
  alter table passkeys add column identity text;
  create unique index passkeys_identity on passkeys(identity);
  `,
]

export function openDb(file: string): Database {
  const db = new Database(file, { create: true, strict: true })
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;')
  const current = (db.query('pragma user_version').get() as { user_version: number }).user_version
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v] as string)
      db.exec(`pragma user_version = ${v + 1}`)
    })()
  }
  return db
}
