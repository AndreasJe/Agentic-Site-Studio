// The app database (bun:sqlite). Metadata only; content lives in DATA_DIR (CLAUDE.md Stack).
// Migrations run in order, each once, tracked by user_version.
import { Database } from 'bun:sqlite'

export const MIGRATIONS: string[] = [
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
  `
  create table brief_counters (handle text primary key, next integer not null);
  create table settings (key text primary key, value text not null);
  insert into settings (key, value) values ('brief_approval', 'optional');
  `,
  `
  create table materials (
    project_id text not null references projects(id),
    hash text not null,
    name text not null,
    uploaded_by integer not null references users(id),
    at text not null,
    primary key (project_id, hash)
  );
  `,
  `
  create table brief_approvals (
    id integer primary key,
    project_id text not null references projects(id),
    brief_id text not null,
    user_id integer not null references users(id),
    at text not null
  );
  `,
  `
  create table media (
    id integer primary key,
    scope text not null,
    title text not null,
    alt text not null default '',
    category text not null default 'free',
    subject text not null default '',
    rights text not null default '',
    allowed_use text not null default '',
    licence_expires text,
    hash text not null,
    mime text not null,
    size integer not null,
    filename text not null,
    blocked integer not null default 0,
    archived integer not null default 0,
    created_by integer not null references users(id),
    created_at text not null,
    updated_at text not null
  );
  create index media_scope on media(scope);
  create table media_versions (
    id integer primary key,
    media_id integer not null references media(id),
    hash text not null,
    mime text not null,
    size integer not null,
    filename text not null,
    by_user integer not null references users(id),
    at text not null
  );
  create table media_uses (
    media_id integer not null references media(id),
    ref text not null,
    at text not null,
    primary key (media_id, ref)
  );
  `,
  `
  create table guide_versions (
    n integer primary key,
    by_user integer references users(id),
    at text not null,
    summary text not null,
    based_on integer
  );
  create table brand_logos (
    id integer primary key,
    hash text not null,
    filename text not null,
    parts text not null,
    by_user integer not null references users(id),
    at text not null
  );
  create table brand_logo_recipes (
    id integer primary key,
    logo_id integer not null references brand_logos(id),
    recipe text not null,
    by_user integer not null references users(id),
    at text not null
  );
  create table brand_partials (
    id integer primary key,
    name text not null,
    n integer not null,
    hash text not null,
    by_user integer not null references users(id),
    at text not null,
    unique (name, n)
  );
  `,
  `
  create table artboards (
    id integer primary key,
    project_id text not null references projects(id),
    page_id text not null,
    letter text not null,
    role text not null check (role in ('lead', 'alternative', 'reference', 'state')),
    kind text check (kind in ('state', 'mobile')),
    description text not null default '',
    parent_id integer references artboards(id),
    html_hash text not null,
    css_hash text not null,
    created_by text not null,
    created_at text not null,
    unique (project_id, letter),
    check (
      (role = 'state' and kind is not null and parent_id is not null)
      or (role <> 'state' and kind is null)
    )
  );
  create unique index artboards_one_lead on artboards(project_id, page_id) where role = 'lead';
  create index artboards_page on artboards(project_id, page_id);
  create table sections (
    artboard_id integer not null references artboards(id),
    section_id text not null check (section_id glob 's-[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]'),
    name text not null,
    job text not null default 'inform' check (job in ('inform', 'prove', 'convert')),
    position integer not null,
    copy integer not null default 0,
    media integer not null default 0,
    interactions integer not null default 0,
    mobile integer not null default 0,
    motion integer not null default 0,
    translated integer not null default 0,
    tested integer not null default 0,
    approved_at text,
    approved_by text,
    primary key (artboard_id, section_id)
  );
  create table deviations (
    id integer primary key,
    artboard_id integer not null references artboards(id),
    section_id text,
    rule text not null,
    message text not null,
    status text not null default 'open' check (status in ('open', 'fixed', 'experiment', 'proposed')),
    created_at text not null
  );
  create index deviations_artboard on deviations(artboard_id);
  create table takes (
    id integer primary key,
    artboard_id integer not null references artboards(id),
    scope text not null,
    axis text not null,
    level text not null check (level in ('follow', 'explore', 'think-new')),
    html_hash text not null,
    css_hash text not null,
    created_by text not null,
    created_at text not null,
    applied integer not null default 0
  );
  `,
  // M4 step 5: what a take carries beyond its blobs, and proposals to change the guide (plan §6.6).
  `
  alter table takes add column summary text not null default '';
  alter table takes add column proposals text not null default '[]';
  alter table takes add column prompt text not null default '';
  alter table takes add column steer text not null default '';
  alter table takes add column section_id text;
  alter table takes add column deviation_id integer references deviations(id);
  create table guide_proposals (
    id integer primary key,
    project_id text not null references projects(id),
    deviation_id integer not null references deviations(id),
    proposed_by text not null,
    kind text not null check (kind in ('colour', 'font', 'other')),
    value text not null,
    status text not null default 'open' check (status in ('open', 'accepted', 'declined')),
    created_at text not null,
    unique (deviation_id)
  );
  `,
  // M5 step 1: approving a revision with its package hash, and accessibility findings accepted
  // with a reason (plan §7; M6 applies them to its own findings by rule and target).
  `
  create table revision_approvals (
    project_id text not null references projects(id),
    rev text not null,
    package_hash text not null,
    user_id integer not null references users(id),
    at text not null,
    primary key (project_id, rev)
  );
  create table a11y_acceptances (
    id integer primary key,
    project_id text not null references projects(id),
    rev text not null,
    rule text not null,
    target text not null,
    reason text not null,
    user_id integer not null references users(id),
    at text not null
  );
  create index a11y_acceptances_rev on a11y_acceptances(project_id, rev);
  `,
  // M6 step 3: per-check levels (floor checks are locked to block), their audit trail, check runs
  // on packages, the staged revision per project, and publication requests (plan §13.2, §16.5).
  `
  create table check_settings (
    check_id text primary key,
    level text not null check (level in ('off', 'warn', 'block')),
    updated_by text not null,
    updated_at text not null
  );
  create table check_audit (
    id integer primary key,
    who text not null,
    at text not null,
    check_id text not null,
    from_level text not null,
    to_level text not null
  );
  create table check_runs (
    id text primary key,
    project_id text not null references projects(id),
    rev text not null,
    hash text not null,
    kind text not null check (kind in ('package', 'smoke')),
    status text not null default 'queued' check (status in ('queued', 'running', 'done')),
    blocked integer not null default 0,
    result_json text,
    error text,
    rerun_of text references check_runs(id),
    at text not null
  );
  create index check_runs_project on check_runs(project_id, at);
  create table staged (
    project_id text primary key references projects(id),
    rev text not null,
    hash text not null,
    at text not null
  );
  create table publication_requests (
    id integer primary key,
    project_id text not null references projects(id),
    rev text not null,
    hash text not null,
    note text not null,
    user_id integer not null references users(id),
    at text not null,
    status text not null default 'open' check (status in ('open', 'superseded'))
  );
  create index publication_requests_project on publication_requests(project_id, status);
  `,
  // M6 step 4: the analyst's answers to failed check runs, the hold comments, and the take a sent
  // fix became (plan §13.5; decision #21). Nothing here ever makes a revision.
  `
  create table failure_analyses (
    id integer primary key,
    run_id text not null references check_runs(id),
    project_id text not null references projects(id),
    lineage text not null,
    attempt integer not null,
    analysed integer not null default 1,
    status text not null check (status in ('ready', 'held', 'sent', 'failed')),
    recommendation text not null check (recommendation in ('fix', 'hold', 'let-through')),
    issues_json text not null default '[]',
    patch_json text,
    note text,
    comment text,
    take_id integer references takes(id),
    created_by text not null,
    at text not null
  );
  create index failure_analyses_run on failure_analyses(run_id);
  create index failure_analyses_lineage on failure_analyses(lineage);
  `,
  // M7 deployment side: pairing, certificates, mail, address-request decisions, site languages.
  `
  alter table users add column email text;
  create table deploy_targets (
    target text primary key check (target glob '[a-z]*' and target not glob '*[^a-z0-9-]*'),
    kind text not null check (kind in ('sftp', 'folder')),
    host text,
    port integer,
    username text,
    inbox_dir text,
    outbox_dir text,
    host_fp_seen text,
    host_fp text,
    domains text not null default '[]',
    status text not null default 'connecting'
      check (status in ('connecting', 'pinned', 'prepared', 'sent', 'paired')),
    last_sequence integer not null default 0,
    last_release integer not null default 0,
    pending text,
    fingerprint text,
    created_at text not null,
    updated_at text not null
  );
  create table cert_issues (
    id integer primary key,
    target text not null references deploy_targets(target),
    host text not null,
    csr_hash text not null,
    csr_pem text not null,
    names text not null,
    cert_pem text,
    issued_at text,
    not_after text,
    status text not null check (status in ('issued', 'failed', 'refused')),
    error text,
    warned_at text,
    at text not null
  );
  create index cert_issues_target on cert_issues(target, host, id);
  create table address_decisions (
    project_id text not null references projects(id),
    name text not null,
    status text not null check (status in ('approved', 'rejected')),
    note text not null default '',
    decided_by text not null,
    at text not null,
    primary key (project_id, name)
  );
  create unique index address_decisions_approved on address_decisions(name) where status = 'approved';
  create table site_languages (
    project_id text primary key references projects(id),
    enabled integer not null default 0,
    default_language text,
    languages text not null default '[]',
    updated_by text not null,
    updated_at text not null
  );
  create table mail_log (
    id integer primary key,
    at text not null,
    recipient text not null,
    kind text not null,
    ok integer not null,
    error text
  );
  `,
  // M7 release side: publication requests that can be sent back or published, Admin keys that are
  // approved or removed for good (#28, #32), the append-only audit log, signing requests and their
  // passkey signatures (releases and commands, #23–#26), warnings acknowledged on the review page,
  // passkey ceremonies (step-up, adding a device), "Waiting for you", and what the outbox poller saw.
  `
  create table publication_requests_m7 (
    id integer primary key,
    project_id text not null references projects(id),
    rev text not null,
    hash text not null,
    note text not null,
    user_id integer not null references users(id),
    at text not null,
    status text not null default 'open'
      check (status in ('open', 'superseded', 'sent-back', 'published')),
    closed_by text,
    closed_note text,
    closed_at text
  );
  insert into publication_requests_m7 (id, project_id, rev, hash, note, user_id, at, status)
    select id, project_id, rev, hash, note, user_id, at, status from publication_requests;
  drop table publication_requests;
  alter table publication_requests_m7 rename to publication_requests;
  create index publication_requests_project on publication_requests(project_id, status);
  alter table passkeys add column approved_at text;
  alter table passkeys add column removed_at text;
  create table audit_log (
    id integer primary key,
    at text not null,
    who text not null,
    action text not null,
    detail text not null default '{}'
  );
  create trigger audit_log_no_update before update on audit_log
    begin select raise(abort, 'the audit log is append-only'); end;
  create trigger audit_log_no_delete before delete on audit_log
    begin select raise(abort, 'the audit log is append-only'); end;
  create table signing_requests (
    id integer primary key,
    kind text not null check (kind in ('release', 'command', 'app-only')),
    purpose text not null,
    target text,
    ref text not null,
    body text not null,
    challenge text not null,
    needed integer not null check (needed between 0 and 2),
    owner text,
    number integer,
    effect text not null default '{}',
    status text not null default 'open'
      check (status in ('open', 'signed', 'sent', 'accepted', 'refused', 'stale', 'cancelled', 'done')),
    outcome text,
    smoke text,
    created_by text not null,
    created_at text not null,
    expires_at integer not null,
    sent_at text,
    done_at text
  );
  create index signing_requests_ref on signing_requests(ref, status);
  create index signing_requests_target on signing_requests(target, kind, number);
  create table signing_signatures (
    request_id integer not null references signing_requests(id),
    user_id integer not null references users(id),
    admin_id text not null,
    key_id text not null,
    authenticator_data text not null,
    client_data_json text not null,
    signature text not null,
    at text not null,
    primary key (request_id, user_id)
  );
  create table review_acknowledgements (
    request_id integer not null references publication_requests(id),
    check_id text not null,
    reason text not null,
    user_id integer not null references users(id),
    at text not null,
    primary key (request_id, check_id)
  );
  create table ceremonies (
    id text primary key,
    user_id integer not null references users(id),
    purpose text not null check (purpose in ('step-up', 'add-key')),
    payload text not null,
    challenge text not null,
    expires_at integer not null
  );
  create table inbox_items (
    id integer primary key,
    kind text not null,
    ref text not null,
    title text not null,
    created_at text not null,
    done_at text
  );
  create unique index inbox_items_open on inbox_items(kind, ref) where done_at is null;
  create table outbox_seen (
    target text not null,
    name text not null,
    digest text not null,
    at text not null,
    body text,
    primary key (target, name)
  );
  `,
  // M8: model endpoints (keys sealed) and the role mapping, and per-project daily usage totals that
  // per-person rows are folded into once they are older than the retention period.
  `
  create table model_endpoints (
    id integer primary key,
    name text not null unique,
    base_url text not null,
    model text not null,
    capability text not null default 'json_schema'
      check (capability in ('json_schema', 'json_object', 'none')),
    capability_override integer not null default 0,
    key_sealed text,
    created_by text not null,
    created_at text not null,
    tested_at text,
    last_test_ok integer,
    last_test_error text
  );
  create table model_roles (
    role text primary key check (role in ('writer', 'sorter', 'critic', 'analyst', 'design', 'suggestions')),
    endpoint_id integer not null references model_endpoints(id)
  );
  create table usage_daily (
    day text not null,
    project text not null,
    phase text not null,
    role text not null,
    calls integer not null default 0,
    attempts integer not null default 0,
    input_tokens integer not null default 0,
    output_tokens integer not null default 0,
    cached_tokens integer not null default 0,
    primary key (day, project, phase, role)
  );
  `,
  // M7 review: re-pairing a live target works on a candidate; the live pairing (and with it the
  // kill switch) stays in deploy_targets until the new pairing file is confirmed.
  `
  create table deploy_candidates (
    target text primary key references deploy_targets(target),
    kind text not null check (kind in ('sftp', 'folder')),
    host text,
    port integer,
    username text,
    inbox_dir text,
    outbox_dir text,
    host_fp_seen text,
    host_fp text,
    domains text not null default '[]',
    status text not null check (status in ('connecting', 'pinned', 'prepared')),
    pending text,
    fingerprint text,
    created_at text not null,
    updated_at text not null
  );
  `,
  // Decision 22 Oct #7: an address request sent at once, outside the private draft.
  `
  create table address_requests (
    project_id text not null references projects(id),
    name text not null,
    page_id text not null,
    page_title text,
    note text not null default '',
    by text not null,
    at text not null,
    primary key (project_id, name)
  );
  `,
  // Decision #50, item 10: inbox files to clear, queued once production's outbox has a result for
  // that exact name (and the bundle with its release), and removed by the next poll.
  `
  create table inbox_cleanup (
    target text not null,
    name text not null,
    queued_at text not null,
    removed_at text,
    attempts integer not null default 0,
    primary key (target, name)
  );
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
