create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create schema if not exists trace_private;
revoke all on schema trace_private from public,anon,authenticated;
grant usage on schema trace_private to service_role;
create table if not exists trace_private.worker_auth (
  singleton boolean primary key default true check(singleton), token_hash text not null
);
alter table trace_private.worker_auth enable row level security;
revoke all on trace_private.worker_auth from public,anon,authenticated;
grant select on trace_private.worker_auth to service_role;
do $bootstrap$
declare secret_value text;
begin
  select decrypted_secret into secret_value from vault.decrypted_secrets where name='trace_worker_token';
  if secret_value is null then
    secret_value := encode(extensions.gen_random_bytes(32),'hex');
    perform vault.create_secret(secret_value,'trace_worker_token','Trace background worker authentication');
  end if;
  insert into trace_private.worker_auth(singleton,token_hash) values(true,encode(extensions.digest(secret_value,'sha256'),'hex'))
  on conflict(singleton) do update set token_hash=excluded.token_hash;
end $bootstrap$;
create or replace function public.trace_worker_authorized(p_token text) returns boolean
language sql stable security invoker set search_path='' as $body$
 select length(p_token) between 32 and 256 and exists (
   select 1 from trace_private.worker_auth where token_hash=encode(extensions.digest(p_token,'sha256'),'hex')
 );
$body$;
revoke execute on function public.trace_worker_authorized(text) from public,anon,authenticated;
grant execute on function public.trace_worker_authorized(text) to service_role;
select cron.schedule('trace-process-checkpoints','* * * * *',$job$
 select net.http_post(
 url:='https://sbupyqgysoznucelwsij.supabase.co/functions/v1/trace/api/internal/process',
 headers:=jsonb_build_object('Content-Type','application/json','x-trace-worker-secret',(select decrypted_secret from vault.decrypted_secrets where name='trace_worker_token')),
 body:='{}'::jsonb, timeout_milliseconds:=120000
 ) where exists (select 1 from public.trace_events where deleted_at is null and
 ((status='pending' and available_at<=now()) or (status='processing' and lease_until<now())))
 or exists (select 1 from public.trace_events where deleted_at<now()-interval '3 minutes' and not image_deleted);
$job$);
