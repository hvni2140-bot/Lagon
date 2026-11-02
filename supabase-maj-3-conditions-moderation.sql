-- ============================================================
-- Lagon : mise à jour 3 — conditions d'utilisation et modération
-- À coller dans Supabase > SQL Editor > Run (une seule fois)
--
-- • Chaque membre doit accepter les conditions avant d'écrire.
-- • Le gérant peut LIRE toutes les discussions et tous les médias
--   (comme annoncé dans les conditions), sans pouvoir écrire
--   dans les discussions privées des autres.
-- • Le gérant peut supprimer n'importe quel message ou média.
-- ============================================================

alter table public.profiles add column if not exists terms_accepted_at timestamptz;

create or replace function public.accept_terms() returns void
language sql security definer set search_path = public as $$
  update profiles set terms_accepted_at = now() where id = auth.uid()
$$;
revoke execute on function public.accept_terms() from anon, public;
grant execute on function public.accept_terms() to authenticated;

create or replace function public.terms_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select terms_accepted_at is not null from profiles where id = auth.uid()), false)
$$;

-- Lecture : participants, ou gérant
create or replace function public.can_read(conv uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_access(conv) or public.is_admin()
$$;

create or replace function public.can_read_media(path text) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  return public.can_read(split_part(path, '/', 1)::uuid);
exception when others then
  return false;
end $$;

-- Discussions et participants
drop policy if exists "Voir ses discussions" on public.conversations;
create policy "Voir ses discussions" on public.conversations
  for select to authenticated using (public.can_read(id));

drop policy if exists "Voir les participants" on public.conversation_members;
create policy "Voir les participants" on public.conversation_members
  for select to authenticated using (public.can_read(conversation_id));

-- Messages
drop policy if exists "Lire les messages de ses discussions" on public.messages;
create policy "Lire les messages de ses discussions" on public.messages
  for select to authenticated using (public.can_read(conversation_id));

drop policy if exists "Écrire dans ses discussions" on public.messages;
create policy "Écrire dans ses discussions" on public.messages
  for insert to authenticated
  with check (sender_id = auth.uid()
              and public.can_access(conversation_id)
              and not public.is_blocked()
              and public.terms_ok());

drop policy if exists "Supprimer ses messages, ou ceux du groupe pour le gérant" on public.messages;
drop policy if exists "Supprimer ses messages, ou tous pour le gérant" on public.messages;
create policy "Supprimer ses messages, ou tous pour le gérant" on public.messages
  for delete to authenticated
  using (sender_id = auth.uid() or public.is_admin());

-- Photos et vidéos
drop policy if exists "Voir les médias de ses discussions" on storage.objects;
create policy "Voir les médias de ses discussions" on storage.objects
  for select to authenticated
  using (bucket_id = 'media' and public.can_read_media(name));

drop policy if exists "Le gérant supprime les médias" on storage.objects;
create policy "Le gérant supprime les médias" on storage.objects
  for delete to authenticated
  using (bucket_id = 'media' and public.is_admin());
