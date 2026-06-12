-- jobs.queue @ 1.0.0 — migration 001
-- The graphile_worker schema, part-owned (docs/02 §6). GENERATED from
-- graphile-worker's OWN migrator (runMigrations) at the pinned version, then
-- dumped (pg_dump --inserts --no-owner --no-privileges) — the auth.session
-- pattern: the wrapped library generates its own schema; partkit migrate owns
-- the ledger. The 18 INSERTs into graphile_worker.migrations record every
-- graphile-worker migration as applied, so the worker's boot-time migrate is a
-- verified no-op against this schema (conformance proves it). A graphile-worker
-- release that bumps the schema is a jobs.queue MINOR that ships a new migration.
-- Do NOT run graphile-worker's migrator separately; partkit migrate owns this.
--
-- BOUNDARY NOTE: graphile-worker mandates a dedicated schema (graphile_worker),
-- a STRONGER namespace boundary than the docs/02 §6 table-prefix convention —
-- every object here is graphile_worker.*, so it cannot collide with app or
-- other-part tables. Reconciled in docs/02 §6 (a part may own a dedicated
-- schema where its wrapped library requires one).
--
-- Transactional (no -- partkit:no-transaction directive); partkit migrate wraps
-- the whole file in one BEGIN/COMMIT, so this file carries no BEGIN/COMMIT and
-- no psql meta-commands.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: graphile_worker; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA graphile_worker;


--
-- Name: job_spec; Type: TYPE; Schema: graphile_worker; Owner: -
--

CREATE TYPE graphile_worker.job_spec AS (
	identifier text,
	payload json,
	queue_name text,
	run_at timestamp with time zone,
	max_attempts smallint,
	job_key text,
	priority smallint,
	flags text[]
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: _private_jobs; Type: TABLE; Schema: graphile_worker; Owner: -
--

CREATE TABLE graphile_worker._private_jobs (
    id bigint NOT NULL,
    job_queue_id integer,
    task_id integer NOT NULL,
    payload json DEFAULT '{}'::json NOT NULL,
    priority smallint DEFAULT 0 NOT NULL,
    run_at timestamp with time zone DEFAULT now() NOT NULL,
    attempts smallint DEFAULT 0 NOT NULL,
    max_attempts smallint DEFAULT 25 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    key text,
    locked_at timestamp with time zone,
    locked_by text,
    revision integer DEFAULT 0 NOT NULL,
    flags jsonb,
    is_available boolean GENERATED ALWAYS AS (((locked_at IS NULL) AND (attempts < max_attempts))) STORED NOT NULL,
    CONSTRAINT jobs_key_check CHECK (((length(key) > 0) AND (length(key) <= 512))),
    CONSTRAINT jobs_max_attempts_check CHECK ((max_attempts >= 1))
);


--
-- Name: add_job(text, json, text, timestamp with time zone, integer, text, integer, text[], text); Type: FUNCTION; Schema: graphile_worker; Owner: -
--

CREATE FUNCTION graphile_worker.add_job(identifier text, payload json DEFAULT NULL::json, queue_name text DEFAULT NULL::text, run_at timestamp with time zone DEFAULT NULL::timestamp with time zone, max_attempts integer DEFAULT NULL::integer, job_key text DEFAULT NULL::text, priority integer DEFAULT NULL::integer, flags text[] DEFAULT NULL::text[], job_key_mode text DEFAULT 'replace'::text) RETURNS graphile_worker._private_jobs
    LANGUAGE plpgsql
    AS $$
declare
  v_job "graphile_worker"._private_jobs;
begin
  if (job_key is null or job_key_mode is null or job_key_mode in ('replace', 'preserve_run_at')) then
    select * into v_job
    from "graphile_worker".add_jobs(
      ARRAY[(
        identifier,
        payload,
        queue_name,
        run_at,
        max_attempts::smallint,
        job_key,
        priority::smallint,
        flags
      )::"graphile_worker".job_spec],
      (job_key_mode = 'preserve_run_at')
    )
    limit 1;
    return v_job;
  elsif job_key_mode = 'unsafe_dedupe' then
    -- Ensure all the tasks exist
    insert into "graphile_worker"._private_tasks as tasks (identifier)
    values (add_job.identifier)
    on conflict do nothing;
    -- Ensure all the queues exist
    if add_job.queue_name is not null then
      insert into "graphile_worker"._private_job_queues as job_queues (queue_name)
      values (add_job.queue_name)
      on conflict do nothing;
    end if;
    -- Insert job, but if one already exists then do nothing, even if the
    -- existing job has already started (and thus represents an out-of-date
    -- world state). This is dangerous because it means that whatever state
    -- change triggered this add_job may not be acted upon (since it happened
    -- after the existing job started executing, but no further job is being
    -- scheduled), but it is useful in very rare circumstances for
    -- de-duplication. If in doubt, DO NOT USE THIS.
    insert into "graphile_worker"._private_jobs as jobs (
      job_queue_id,
      task_id,
      payload,
      run_at,
      max_attempts,
      key,
      priority,
      flags
    )
      select
        job_queues.id,
        tasks.id,
        coalesce(add_job.payload, '{}'::json),
        coalesce(add_job.run_at, now()),
        coalesce(add_job.max_attempts::smallint, 25::smallint),
        add_job.job_key,
        coalesce(add_job.priority::smallint, 0::smallint),
        (
          select jsonb_object_agg(flag, true)
          from unnest(add_job.flags) as item(flag)
        )
      from "graphile_worker"._private_tasks as tasks
      left join "graphile_worker"._private_job_queues as job_queues
      on job_queues.queue_name = add_job.queue_name
      where tasks.identifier = add_job.identifier
    on conflict (key)
      -- Bump the updated_at so that there's something to return
      do update set
        revision = jobs.revision + 1,
        updated_at = now()
      returning *
      into v_job;
    if v_job.revision = 0 then
      perform pg_notify('jobs:insert', '{"r":' || random()::text || ',"count":1}');
    end if;
    return v_job;
  else
    raise exception 'Invalid job_key_mode value, expected ''replace'', ''preserve_run_at'' or ''unsafe_dedupe''.' using errcode = 'GWBKM';
  end if;
end;
$$;


--
-- Name: add_jobs(graphile_worker.job_spec[], boolean); Type: FUNCTION; Schema: graphile_worker; Owner: -
--

CREATE FUNCTION graphile_worker.add_jobs(specs graphile_worker.job_spec[], job_key_preserve_run_at boolean DEFAULT false) RETURNS SETOF graphile_worker._private_jobs
    LANGUAGE plpgsql
    AS $$
begin
  -- Ensure all the tasks exist
  insert into "graphile_worker"._private_tasks as tasks (identifier)
  select distinct spec.identifier
  from unnest(specs) spec
  on conflict do nothing;
  -- Ensure all the queues exist
  insert into "graphile_worker"._private_job_queues as job_queues (queue_name)
  select distinct spec.queue_name
  from unnest(specs) spec
  where spec.queue_name is not null
  on conflict do nothing;
  -- Ensure any locked jobs have their key cleared - in the case of locked
  -- existing job create a new job instead as it must have already started
  -- executing (i.e. it's world state is out of date, and the fact add_job
  -- has been called again implies there's new information that needs to be
  -- acted upon).
  update "graphile_worker"._private_jobs as jobs
  set
    key = null,
    attempts = jobs.max_attempts,
    updated_at = now()
  from unnest(specs) spec
  where spec.job_key is not null
  and jobs.key = spec.job_key
  and is_available is not true;

  -- WARNING: this count is not 100% accurate; 'on conflict' clause will cause it to be an overestimate
  perform pg_notify('jobs:insert', '{"r":' || random()::text || ',"count":' || array_length(specs, 1)::text || '}');

  -- TODO: is there a risk that a conflict could occur depending on the
  -- isolation level?
  return query insert into "graphile_worker"._private_jobs as jobs (
    job_queue_id,
    task_id,
    payload,
    run_at,
    max_attempts,
    key,
    priority,
    flags
  )
    select
      job_queues.id,
      tasks.id,
      coalesce(spec.payload, '{}'::json),
      coalesce(spec.run_at, now()),
      coalesce(spec.max_attempts, 25),
      spec.job_key,
      coalesce(spec.priority, 0),
      (
        select jsonb_object_agg(flag, true)
        from unnest(spec.flags) as item(flag)
      )
    from unnest(specs) spec
    inner join "graphile_worker"._private_tasks as tasks
    on tasks.identifier = spec.identifier
    left join "graphile_worker"._private_job_queues as job_queues
    on job_queues.queue_name = spec.queue_name
  on conflict (key) do update set
    job_queue_id = excluded.job_queue_id,
    task_id = excluded.task_id,
    payload =
      case
      when json_typeof(jobs.payload) = 'array' and json_typeof(excluded.payload) = 'array' then
        (jobs.payload::jsonb || excluded.payload::jsonb)::json
      else
        excluded.payload
      end,
    max_attempts = excluded.max_attempts,
    run_at = (case
      when job_key_preserve_run_at is true and jobs.attempts = 0 then jobs.run_at
      else excluded.run_at
    end),
    priority = excluded.priority,
    revision = jobs.revision + 1,
    flags = excluded.flags,
    -- always reset error/retry state
    attempts = 0,
    last_error = null,
    updated_at = now()
  where jobs.locked_at is null
  returning *;
end;
$$;


--
-- Name: complete_jobs(bigint[]); Type: FUNCTION; Schema: graphile_worker; Owner: -
--

CREATE FUNCTION graphile_worker.complete_jobs(job_ids bigint[]) RETURNS SETOF graphile_worker._private_jobs
    LANGUAGE sql
    AS $$
  delete from "graphile_worker"._private_jobs as jobs
    where id = any(job_ids)
    and (
      locked_at is null
    or
      locked_at < now() - interval '4 hours'
    )
    returning *;
$$;


--
-- Name: force_unlock_workers(text[]); Type: FUNCTION; Schema: graphile_worker; Owner: -
--

CREATE FUNCTION graphile_worker.force_unlock_workers(worker_ids text[]) RETURNS void
    LANGUAGE sql
    AS $$
update "graphile_worker"._private_jobs as jobs
set locked_at = null, locked_by = null
where locked_by = any(worker_ids);
update "graphile_worker"._private_job_queues as job_queues
set locked_at = null, locked_by = null
where locked_by = any(worker_ids);
$$;


--
-- Name: permanently_fail_jobs(bigint[], text); Type: FUNCTION; Schema: graphile_worker; Owner: -
--

CREATE FUNCTION graphile_worker.permanently_fail_jobs(job_ids bigint[], error_message text DEFAULT NULL::text) RETURNS SETOF graphile_worker._private_jobs
    LANGUAGE sql
    AS $$
  update "graphile_worker"._private_jobs as jobs
    set
      last_error = coalesce(error_message, 'Manually marked as failed'),
      attempts = max_attempts,
      updated_at = now()
    where id = any(job_ids)
    and (
      locked_at is null
    or
      locked_at < NOW() - interval '4 hours'
    )
    returning *;
$$;


--
-- Name: remove_job(text); Type: FUNCTION; Schema: graphile_worker; Owner: -
--

CREATE FUNCTION graphile_worker.remove_job(job_key text) RETURNS graphile_worker._private_jobs
    LANGUAGE plpgsql STRICT
    AS $$
declare
  v_job "graphile_worker"._private_jobs;
begin
  -- Delete job if not locked
  delete from "graphile_worker"._private_jobs as jobs
    where key = job_key
    and (
      locked_at is null
    or
      locked_at < NOW() - interval '4 hours'
    )
  returning * into v_job;
  if not (v_job is null) then
    perform pg_notify('jobs:insert', '{"r":' || random()::text || ',"count":-1}');
    return v_job;
  end if;
  -- Otherwise prevent job from retrying, and clear the key
  update "graphile_worker"._private_jobs as jobs
  set
    key = null,
    attempts = jobs.max_attempts,
    updated_at = now()
  where key = job_key
  returning * into v_job;
  return v_job;
end;
$$;


--
-- Name: reschedule_jobs(bigint[], timestamp with time zone, integer, integer, integer); Type: FUNCTION; Schema: graphile_worker; Owner: -
--

CREATE FUNCTION graphile_worker.reschedule_jobs(job_ids bigint[], run_at timestamp with time zone DEFAULT NULL::timestamp with time zone, priority integer DEFAULT NULL::integer, attempts integer DEFAULT NULL::integer, max_attempts integer DEFAULT NULL::integer) RETURNS SETOF graphile_worker._private_jobs
    LANGUAGE sql
    AS $$
  update "graphile_worker"._private_jobs as jobs
    set
      run_at = coalesce(reschedule_jobs.run_at, jobs.run_at),
      priority = coalesce(reschedule_jobs.priority::smallint, jobs.priority),
      attempts = coalesce(reschedule_jobs.attempts::smallint, jobs.attempts),
      max_attempts = coalesce(reschedule_jobs.max_attempts::smallint, jobs.max_attempts),
      updated_at = now()
    where id = any(job_ids)
    and (
      locked_at is null
    or
      locked_at < NOW() - interval '4 hours'
    )
    returning *;
$$;


--
-- Name: _private_job_queues; Type: TABLE; Schema: graphile_worker; Owner: -
--

CREATE TABLE graphile_worker._private_job_queues (
    id integer NOT NULL,
    queue_name text NOT NULL,
    locked_at timestamp with time zone,
    locked_by text,
    is_available boolean GENERATED ALWAYS AS ((locked_at IS NULL)) STORED NOT NULL,
    CONSTRAINT job_queues_queue_name_check CHECK ((length(queue_name) <= 128))
);


--
-- Name: _private_known_crontabs; Type: TABLE; Schema: graphile_worker; Owner: -
--

CREATE TABLE graphile_worker._private_known_crontabs (
    identifier text NOT NULL,
    known_since timestamp with time zone NOT NULL,
    last_execution timestamp with time zone
);


--
-- Name: _private_tasks; Type: TABLE; Schema: graphile_worker; Owner: -
--

CREATE TABLE graphile_worker._private_tasks (
    id integer NOT NULL,
    identifier text NOT NULL,
    CONSTRAINT tasks_identifier_check CHECK ((length(identifier) <= 128))
);


--
-- Name: job_queues_id_seq; Type: SEQUENCE; Schema: graphile_worker; Owner: -
--

ALTER TABLE graphile_worker._private_job_queues ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME graphile_worker.job_queues_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: jobs; Type: VIEW; Schema: graphile_worker; Owner: -
--

CREATE VIEW graphile_worker.jobs AS
 SELECT jobs.id,
    job_queues.queue_name,
    tasks.identifier AS task_identifier,
    jobs.priority,
    jobs.run_at,
    jobs.attempts,
    jobs.max_attempts,
    jobs.last_error,
    jobs.created_at,
    jobs.updated_at,
    jobs.key,
    jobs.locked_at,
    jobs.locked_by,
    jobs.revision,
    jobs.flags
   FROM ((graphile_worker._private_jobs jobs
     JOIN graphile_worker._private_tasks tasks ON ((tasks.id = jobs.task_id)))
     LEFT JOIN graphile_worker._private_job_queues job_queues ON ((job_queues.id = jobs.job_queue_id)));


--
-- Name: jobs_id_seq1; Type: SEQUENCE; Schema: graphile_worker; Owner: -
--

ALTER TABLE graphile_worker._private_jobs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME graphile_worker.jobs_id_seq1
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: migrations; Type: TABLE; Schema: graphile_worker; Owner: -
--

CREATE TABLE graphile_worker.migrations (
    id integer NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    breaking boolean DEFAULT false NOT NULL
);


--
-- Name: tasks_id_seq; Type: SEQUENCE; Schema: graphile_worker; Owner: -
--

ALTER TABLE graphile_worker._private_tasks ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME graphile_worker.tasks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Data for Name: _private_job_queues; Type: TABLE DATA; Schema: graphile_worker; Owner: -
--



--
-- Data for Name: _private_jobs; Type: TABLE DATA; Schema: graphile_worker; Owner: -
--



--
-- Data for Name: _private_known_crontabs; Type: TABLE DATA; Schema: graphile_worker; Owner: -
--



--
-- Data for Name: _private_tasks; Type: TABLE DATA; Schema: graphile_worker; Owner: -
--



--
-- Data for Name: migrations; Type: TABLE DATA; Schema: graphile_worker; Owner: -
--

INSERT INTO graphile_worker.migrations VALUES (1, '2026-06-12 12:13:30.70251+02', true);
INSERT INTO graphile_worker.migrations VALUES (2, '2026-06-12 12:13:30.734835+02', false);
INSERT INTO graphile_worker.migrations VALUES (3, '2026-06-12 12:13:30.739373+02', true);
INSERT INTO graphile_worker.migrations VALUES (4, '2026-06-12 12:13:30.741333+02', false);
INSERT INTO graphile_worker.migrations VALUES (5, '2026-06-12 12:13:30.744003+02', false);
INSERT INTO graphile_worker.migrations VALUES (6, '2026-06-12 12:13:30.745642+02', false);
INSERT INTO graphile_worker.migrations VALUES (7, '2026-06-12 12:13:30.749211+02', false);
INSERT INTO graphile_worker.migrations VALUES (8, '2026-06-12 12:13:30.751968+02', false);
INSERT INTO graphile_worker.migrations VALUES (9, '2026-06-12 12:13:30.755354+02', false);
INSERT INTO graphile_worker.migrations VALUES (10, '2026-06-12 12:13:30.756111+02', false);
INSERT INTO graphile_worker.migrations VALUES (11, '2026-06-12 12:13:30.756548+02', true);
INSERT INTO graphile_worker.migrations VALUES (12, '2026-06-12 12:13:30.77138+02', false);
INSERT INTO graphile_worker.migrations VALUES (13, '2026-06-12 12:13:30.772227+02', true);
INSERT INTO graphile_worker.migrations VALUES (14, '2026-06-12 12:13:30.773029+02', true);
INSERT INTO graphile_worker.migrations VALUES (15, '2026-06-12 12:13:30.773979+02', false);
INSERT INTO graphile_worker.migrations VALUES (16, '2026-06-12 12:13:30.774432+02', true);
INSERT INTO graphile_worker.migrations VALUES (17, '2026-06-12 12:13:30.7759+02', false);
INSERT INTO graphile_worker.migrations VALUES (18, '2026-06-12 12:13:30.780298+02', false);


--
-- Name: job_queues_id_seq; Type: SEQUENCE SET; Schema: graphile_worker; Owner: -
--

SELECT pg_catalog.setval('graphile_worker.job_queues_id_seq', 1, false);


--
-- Name: jobs_id_seq1; Type: SEQUENCE SET; Schema: graphile_worker; Owner: -
--

SELECT pg_catalog.setval('graphile_worker.jobs_id_seq1', 1, false);


--
-- Name: tasks_id_seq; Type: SEQUENCE SET; Schema: graphile_worker; Owner: -
--

SELECT pg_catalog.setval('graphile_worker.tasks_id_seq', 1, false);


--
-- Name: _private_job_queues job_queues_pkey1; Type: CONSTRAINT; Schema: graphile_worker; Owner: -
--

ALTER TABLE ONLY graphile_worker._private_job_queues
    ADD CONSTRAINT job_queues_pkey1 PRIMARY KEY (id);


--
-- Name: _private_job_queues job_queues_queue_name_key; Type: CONSTRAINT; Schema: graphile_worker; Owner: -
--

ALTER TABLE ONLY graphile_worker._private_job_queues
    ADD CONSTRAINT job_queues_queue_name_key UNIQUE (queue_name);


--
-- Name: _private_jobs jobs_key_key1; Type: CONSTRAINT; Schema: graphile_worker; Owner: -
--

ALTER TABLE ONLY graphile_worker._private_jobs
    ADD CONSTRAINT jobs_key_key1 UNIQUE (key);


--
-- Name: _private_jobs jobs_pkey1; Type: CONSTRAINT; Schema: graphile_worker; Owner: -
--

ALTER TABLE ONLY graphile_worker._private_jobs
    ADD CONSTRAINT jobs_pkey1 PRIMARY KEY (id);


--
-- Name: _private_known_crontabs known_crontabs_pkey; Type: CONSTRAINT; Schema: graphile_worker; Owner: -
--

ALTER TABLE ONLY graphile_worker._private_known_crontabs
    ADD CONSTRAINT known_crontabs_pkey PRIMARY KEY (identifier);


--
-- Name: migrations migrations_pkey; Type: CONSTRAINT; Schema: graphile_worker; Owner: -
--

ALTER TABLE ONLY graphile_worker.migrations
    ADD CONSTRAINT migrations_pkey PRIMARY KEY (id);


--
-- Name: _private_tasks tasks_identifier_key; Type: CONSTRAINT; Schema: graphile_worker; Owner: -
--

ALTER TABLE ONLY graphile_worker._private_tasks
    ADD CONSTRAINT tasks_identifier_key UNIQUE (identifier);


--
-- Name: _private_tasks tasks_pkey; Type: CONSTRAINT; Schema: graphile_worker; Owner: -
--

ALTER TABLE ONLY graphile_worker._private_tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: jobs_main_index; Type: INDEX; Schema: graphile_worker; Owner: -
--

CREATE INDEX jobs_main_index ON graphile_worker._private_jobs USING btree (priority, run_at) INCLUDE (id, task_id, job_queue_id) WHERE (is_available = true);


--
-- Name: jobs_no_queue_index; Type: INDEX; Schema: graphile_worker; Owner: -
--

CREATE INDEX jobs_no_queue_index ON graphile_worker._private_jobs USING btree (priority, run_at) INCLUDE (id, task_id) WHERE ((is_available = true) AND (job_queue_id IS NULL));


--
-- Name: _private_job_queues; Type: ROW SECURITY; Schema: graphile_worker; Owner: -
--

ALTER TABLE graphile_worker._private_job_queues ENABLE ROW LEVEL SECURITY;

--
-- Name: _private_jobs; Type: ROW SECURITY; Schema: graphile_worker; Owner: -
--

ALTER TABLE graphile_worker._private_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: _private_known_crontabs; Type: ROW SECURITY; Schema: graphile_worker; Owner: -
--

ALTER TABLE graphile_worker._private_known_crontabs ENABLE ROW LEVEL SECURITY;

--
-- Name: _private_tasks; Type: ROW SECURITY; Schema: graphile_worker; Owner: -
--

ALTER TABLE graphile_worker._private_tasks ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--


