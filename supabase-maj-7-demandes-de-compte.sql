-- ============================================================
-- Sunset : mise à jour 7 — demandes de compte validées par le gérant
-- Un compte créé depuis l'écran de connexion reste « en attente »
-- et n'a accès à rien tant que le gérant ne l'a pas accepté.
-- ============================================================

-- Les comptes existants sont acceptés ; les nouveaux arrivent en attente
alter table public.profiles add column if not exists status text not null default 'approved'
  check (status in ('pending', 'approved', 'rejected'));
alter table public.profiles alter column status set default 'pending';

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, display_name, is_admin, login, status)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
                  split_part(new.email, '@', 1)), 40),
    not exists (select 1 from profiles),
    case when new.email like '%@lagon.example.com' then split_part(new.email, '@', 1) end,
    case when exists (select 1 from profiles) then 'pending' else 'approved' end
  );
  return new;
end $$;

create or replace function public.is_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select status = 'approved' from profiles where id = auth.uid()), false)
$$;

-- Accès aux discussions : uniquement les comptes acceptés
create or replace function public.can_access(conv uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and public.is_approved() and (
    exists (select 1 from conversations c where c.id = conv and c.is_group)
    or exists (select 1 from conversation_members m
               where m.conversation_id = conv and m.user_id = auth.uid())
  )
$$;

-- Écrire, aimer, commenter, publier : compte accepté et conditions acceptées
create or replace function public.terms_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select terms_accepted_at is not null and status = 'approved'
                   from profiles where id = auth.uid()), false)
$$;

create or replace function public.open_dm(other uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  k text;
  cid uuid;
begin
  if auth.uid() is null or other = auth.uid() or not public.is_approved() then
    raise exception 'Discussion impossible';
  end if;
  if not exists (select 1 from profiles where id = other and status = 'approved') then
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

-- Les comptes en attente ne voient ni les membres ni les photos
drop policy if exists "Profils visibles par les membres" on public.profiles;
create policy "Profils visibles par les membres" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin() or (public.is_approved() and status = 'approved'));

drop policy if exists "Voir les photos des profils" on public.profile_photos;
create policy "Voir les photos des profils" on public.profile_photos
  for select to authenticated using (public.is_approved());
drop policy if exists "Voir les j'aime" on public.photo_likes;
create policy "Voir les j'aime" on public.photo_likes
  for select to authenticated using (public.is_approved());
drop policy if exists "Voir les commentaires" on public.photo_comments;
create policy "Voir les commentaires" on public.photo_comments
  for select to authenticated using (public.is_approved());

drop policy if exists "Voir les photos de profil" on storage.objects;
create policy "Voir les photos de profil" on storage.objects
  for select to authenticated using (bucket_id = 'avatars' and public.is_approved());
drop policy if exists "Ajouter sa photo de profil" on storage.objects;
create policy "Ajouter sa photo de profil" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and public.is_approved()
              and (storage.foldername(name))[1] = (auth.uid())::text);

-- Accepter ou refuser une demande (gérant uniquement)
create or replace function public.set_member_status(target uuid, value text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé au gérant'; end if;
  if target = auth.uid() then raise exception 'Action impossible sur votre propre compte'; end if;
  if value not in ('approved', 'rejected') then raise exception 'Statut invalide'; end if;
  update profiles set status = value where id = target;
end $$;

-- Un compte créé par le gérant dans Gestion est accepté d'office
create or replace function public.approve_login(l text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé au gérant'; end if;
  update profiles set status = 'approved' where login = lower(l);
end $$;

revoke execute on function public.set_member_status(uuid, text), public.approve_login(text) from anon, public;
grant execute on function public.set_member_status(uuid, text), public.approve_login(text) to authenticated;
