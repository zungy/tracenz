-- Run in the Supabase SQL editor for a new project. Supabase Auth owns users.
-- Cloud writes go through the authenticated Trace backend, not the renderer.
create table public.trace_documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  source text not null, source_key text not null, name text not null,
  unique(owner_id,source,source_key), unique(id,owner_id)
);
create table public.trace_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid not null,
  dedupe_key text not null, fingerprint text not null,
  raw_event jsonb not null, captured_at timestamptz not null,
  received_at timestamptz not null default now(),
  status text not null default 'receiving' check(status in ('receiving','pending','processing','complete','failed')),
  ai jsonb, ai_provider text, ai_model text, prompt_version text, error text,
  image_path text not null, image_bytes integer not null check(image_bytes > 0), image_dimensions jsonb not null,
  image_deleted boolean not null default false,
  attempts integer not null default 0,
  available_at timestamptz not null default now(), lease_id uuid, lease_until timestamptz, deleted_at timestamptz,
  search_text text generated always as (raw_event::text || coalesce(ai::text,'')) stored,
  unique(owner_id,dedupe_key), foreign key(document_id,owner_id) references public.trace_documents(id,owner_id)
);
create index trace_events_timeline on public.trace_events(owner_id,captured_at desc,id desc) where deleted_at is null;
create index trace_events_jobs on public.trace_events(status,available_at) where deleted_at is null;
create table public.trace_tokens (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null, token_hash text not null unique, prefix text not null,
  created_at timestamptz not null default now(), revoked_at timestamptz
);
create index trace_events_document_owner on public.trace_events(document_id,owner_id);
create index trace_tokens_owner on public.trace_tokens(owner_id);
alter table public.trace_documents enable row level security;
alter table public.trace_events enable row level security;
alter table public.trace_tokens enable row level security;
create policy "Read own documents" on public.trace_documents for select to authenticated using(owner_id=(select auth.uid()));
create policy "Read own live events" on public.trace_events for select to authenticated using(owner_id=(select auth.uid()) and deleted_at is null);
-- No direct client writes or token reads. Service role is held only by the backend.
revoke all on public.trace_documents,public.trace_events,public.trace_tokens from anon,authenticated;
grant select on public.trace_documents,public.trace_events to authenticated;
grant all on public.trace_documents,public.trace_events,public.trace_tokens to service_role;

create view public.trace_document_overview with (security_invoker=true) as
select d.id,d.owner_id,d.name,d.source,count(e.id)::integer as event_count,max(e.captured_at) as latest_at,
  count(*) filter(where e.status='complete')::integer as complete_count,
  count(*) filter(where e.status in ('receiving','pending','processing'))::integer as pending_count,
  count(*) filter(where e.status='failed')::integer as failed_count
from public.trace_documents d join public.trace_events e on e.document_id=d.id and e.deleted_at is null
group by d.id;
revoke all on public.trace_document_overview from anon;
grant select on public.trace_document_overview to authenticated,service_role;

create function public.trace_ingest(p_owner uuid,p_key text,p_fingerprint text,p_document_key text,p_event jsonb,p_bytes integer,p_dimensions jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare existing public.trace_events; doc_id uuid; event_id uuid:=gen_random_uuid();
begin
  -- Serialize retries of this owner/key, including across backend replicas.
  perform pg_advisory_xact_lock(hashtextextended(p_owner::text || ':' || p_key,0));
  select * into existing from public.trace_events where owner_id=p_owner and dedupe_key=p_key;
  if found then
    if existing.fingerprint<>p_fingerprint then return jsonb_build_object('conflict','Checkpoint ID already belongs to different content.'); end if;
    if existing.deleted_at is not null then return jsonb_build_object('conflict','Checkpoint was deleted; retries cannot recreate it.'); end if;
    return jsonb_build_object('row',to_jsonb(existing),'duplicate',true);
  end if;
  insert into public.trace_documents(owner_id,source,source_key,name) values(p_owner,p_event->>'source',p_document_key,p_event->'document'->>'name')
    on conflict(owner_id,source,source_key) do update set name=excluded.name returning id into doc_id;
  insert into public.trace_events(id,owner_id,document_id,dedupe_key,fingerprint,raw_event,captured_at,image_path,image_bytes,image_dimensions)
    values(event_id,p_owner,doc_id,p_key,p_fingerprint,p_event,(p_event->>'timestamp')::timestamptz,p_owner::text || '/' || event_id::text || '/viewport.png',p_bytes,p_dimensions)
    returning * into existing;
  return jsonb_build_object('row',to_jsonb(existing),'duplicate',false);
end $$;
create function public.trace_claim() returns setof public.trace_events
language sql security invoker set search_path=public as $$
  update public.trace_events set status='processing',attempts=attempts+1,lease_id=gen_random_uuid(),lease_until=now()+interval '3 minutes'
  where id in (select id from public.trace_events where deleted_at is null and attempts<3 and
    ((status='pending' and available_at<=now()) or (status='processing' and lease_until<now()))
    order by received_at for update skip locked limit 1) returning *;
$$;
create function public.trace_recover() returns void
language sql security invoker set search_path=public as $$
  update public.trace_events set status='failed',error='Processing interrupted after three attempts.'
  where status='processing' and attempts>=3 and lease_until<now() and deleted_at is null;
$$;
revoke execute on function public.trace_ingest(uuid,text,text,text,jsonb,integer,jsonb),public.trace_claim(),public.trace_recover() from public,anon,authenticated;
grant execute on function public.trace_ingest(uuid,text,text,text,jsonb,integer,jsonb),public.trace_claim(),public.trace_recover() to service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('trace-viewports','trace-viewports',false,8388608,array['image/png']) on conflict(id) do nothing;
-- Images are served through the authorized backend; no public Storage policy.
