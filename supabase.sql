-- ============================================================
-- Lagon : base de données (à coller dans Supabase > SQL Editor > Run)
-- Messagerie de groupe + discussions privées + photos/vidéos
-- Les règles d'accès (RLS) garantissent qu'une discussion privée
-- n'est lisible QUE par ses deux participants, gérant compris.
-- ============================================================

-- ---------- Tables ----------
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  is_admin boolean not null default false,
  blocked boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  is_group boolean not null default false,
  title text,
  dm_key text unique,              -- "idA:idB" pour une discussion privée
  created_at timestamptz not null default now()
);

create table public.conversation_members (
  conversation_id uuid not null references public.conversations on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  primary key (conversation_id, user_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations on delete cascade,
  sender_id uuid not null default auth.uid() references public.profiles on delete cascade,
  body text check (char_length(body) <= 2000),
  media_path text,
  media_kind text check (media_kind in ('image', 'video')),
  created_at timestamptz not null default now(),
  check (body is not null or media_path is not null)
);
create index messages_conv_time on public.messages (conversation_id, created_at);

-- La discussion de groupe, ouverte à tous les membres
insert into public.conversations (is_group, title) values (true, 'Groupe');

-- ---------- Fonctions utilitaires ----------
create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from profiles where id = auth.uid()), false)
$$;

create function public.is_blocked() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select blocked from profiles where id = auth.uid()), true)
$$;

create function public.can_access(conv uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    exists (select 1 from conversations c where c.id = conv and c.is_group)
    or exists (select 1 from conversation_members m
               where m.conversation_id = conv and m.user_id = auth.uid())
  )
$$;

create function public.can_access_media(path text) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  return public.can_access(split_part(path, '/', 1)::uuid);
exception when others then
  return false;
end $$;

-- Profil créé automatiquement à l'inscription.
-- Le TOUT PREMIER compte créé devient gérant.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, display_name, is_admin)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
                  split_part(new.email, '@', 1)), 40),
    not exists (select 1 from profiles)
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Ouvrir (ou retrouver) la discussion privée avec quelqu'un
create function public.open_dm(other uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  k text;
  cid uuid;
begin
  if auth.uid() is null or other = auth.uid() then
    raise exception 'Discussion impossible';
  end if;
  if not exists (select 1 from profiles where id = other) then
    raise exception 'Membre introuvable';
  end if;
  k := least(auth.uid()::text, other::text) || ':' || greatest(auth.uid()::text, other::text);
  insert into conversations (dm_key) values (k)
    on conflict (dm_key) do nothing
    returning id into cid;
  if cid is null then
    select id into cid from conversations where dm_key = k;
  end if;
  insert into conversation_members (conversation_id, user_id)
    values (cid, auth.uid()), (cid, other)
    on conflict do nothing;
  return cid;
end $$;

-- Bloquer / débloquer un membre (gérant uniquement)
create function public.set_blocked(target uuid, value boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé au gérant'; end if;
  if target = auth.uid() then raise exception 'Vous ne pouvez pas vous bloquer'; end if;
  update profiles set blocked = value where id = target;
end $$;

revoke execute on function public.open_dm(uuid), public.set_blocked(uuid, boolean) from anon, public;
grant execute on function public.open_dm(uuid), public.set_blocked(uuid, boolean) to authenticated;

-- ---------- Règles d'accès ----------
alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;

create policy "Profils visibles par les membres" on public.profiles
  for select to authenticated using (true);
create policy "Chacun modifie son nom" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
-- Personne ne peut se donner le rôle de gérant ou se débloquer soi-même
revoke update on public.profiles from anon, authenticated;
grant update (display_name) on public.profiles to authenticated;

create policy "Voir ses discussions" on public.conversations
  for select to authenticated using (public.can_access(id));

create policy "Voir les participants" on public.conversation_members
  for select to authenticated using (public.can_access(conversation_id));

create policy "Lire les messages de ses discussions" on public.messages
  for select to authenticated using (public.can_access(conversation_id));
create policy "Écrire dans ses discussions" on public.messages
  for insert to authenticated
  with check (sender_id = auth.uid()
              and public.can_access(conversation_id)
              and not public.is_blocked());
create policy "Supprimer ses messages, ou ceux du groupe pour le gérant" on public.messages
  for delete to authenticated
  using (sender_id = auth.uid()
         or (public.is_admin()
             and exists (select 1 from public.conversations c
                         where c.id = conversation_id and c.is_group)));

-- ---------- Stockage des photos et vidéos (privé) ----------
-- Chaque fichier est rangé dans le dossier de sa discussion :
-- seuls les participants de cette discussion peuvent le voir.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 52428800, array['image/*', 'video/*']);

create policy "Voir les médias de ses discussions" on storage.objects
  for select to authenticated
  using (bucket_id = 'media' and public.can_access_media(name));
create policy "Envoyer des médias dans ses discussions" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'media'
              and public.can_access_media(name)
              and not public.is_blocked());
create policy "Supprimer ses propres médias" on storage.objects
  for delete to authenticated
  using (bucket_id = 'media' and owner_id = (auth.uid())::text);

-- ---------- Temps réel ----------
alter publication supabase_realtime add table public.messages;
