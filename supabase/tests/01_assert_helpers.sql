-- Assertion helpers for the SQL verification suites.
--
-- A failed assertion raises an exception, so a run under `psql -v ON_ERROR_STOP=1` stops at the
-- first real failure and exits non-zero. Every passing assertion is recorded in `verify.results`
-- and printed at the end, so a green run produces evidence rather than just "no errors".
--
-- The helper schema is granted to the client roles because the RLS suite runs its assertions
-- *as* those roles: an assertion about what `authenticated` can see has to execute as
-- `authenticated`, including the bookkeeping insert.

create schema if not exists verify;

create table if not exists verify.results (
  seq bigserial primary key,
  area text not null,
  check_name text not null,
  detail text
);

comment on table verify.results is
  'One row per passing assertion. A failing assertion raises instead of writing here.';

create or replace function verify.record(p_area text, p_name text, p_detail text default null)
returns void
language sql
as $$
  insert into verify.results (area, check_name, detail) values (p_area, p_name, p_detail);
$$;

-- Asserts a boolean condition.
create or replace function verify.ok(p_area text, p_name text, p_condition boolean)
returns void
language plpgsql
as $$
begin
  if p_condition is not true then
    raise exception 'FAIL [%] %: condition was %', p_area, p_name, coalesce(p_condition::text, 'null');
  end if;
  perform verify.record(p_area, p_name, 'true');
end;
$$;

-- Asserts equality, reporting both sides on failure.
create or replace function verify.eq(
  p_area text,
  p_name text,
  p_actual anyelement,
  p_expected anyelement
) returns void
language plpgsql
as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL [%] %: expected %, got %', p_area, p_name, p_expected, p_actual;
  end if;
  perform verify.record(p_area, p_name, format('= %s', p_expected));
end;
$$;

-- Asserts that a statement is rejected, recording the SQLSTATE and message as evidence.
--
-- `p_expect` names the constraint, table or phrase the rejection must mention. It matters: without
-- it, a statement that fails for an unrelated reason (a typo'd fixture value, a missing grant)
-- would satisfy the check and hide the fact that the intended constraint was never exercised.
create or replace function verify.rejected(
  p_area text,
  p_name text,
  p_sql text,
  p_expect text default null
)
returns void
language plpgsql
as $$
declare
  v_state text;
  v_message text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
    if p_expect is not null and position(p_expect in v_message) = 0 then
      raise exception 'FAIL [%] %: rejected for the wrong reason. Expected a mention of %, got % (%)',
        p_area, p_name, p_expect, v_message, v_state;
    end if;
    perform verify.record(p_area, p_name, v_state || ' ' || v_message);
    return;
  end;
  raise exception 'FAIL [%] %: statement was accepted but must be rejected', p_area, p_name;
end;
$$;

-- Asserts that a statement is accepted (used for the boundary cases of a constraint).
create or replace function verify.accepted(p_area text, p_name text, p_sql text)
returns void
language plpgsql
as $$
begin
  execute p_sql;
  perform verify.record(p_area, p_name, 'accepted');
end;
$$;

grant usage on schema verify to anon, authenticated, service_role;
grant select, insert on verify.results to anon, authenticated, service_role;
grant usage, select on sequence verify.results_seq_seq to anon, authenticated, service_role;
