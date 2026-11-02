-- ============================================================
-- Sunset : mise à jour 5 — pages profil, photos, j'aime, commentaires
-- ============================================================

create table if not exists public.profile_photos (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles on delete cascade,
  path text not null unique,
  kind text not null default 'photo' check (kind in ('photo', 'avatar')),
  created_at timestamptz not null default now(),
  check (path like owner_id::text || '/%')
);
create index if not exists profile_photos_owner on public.profile_photos (owner_id, created_at desc);

create table if not exists public.photo_likes (
  photo_id uuid not null references public.profile_photos on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (photo_id, user_id)
);

create table if not exists public.photo_comments (
  id uuid primary key default gen_random_uuid(),
  photo_id uuid not null references public.profile_photos on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists photo_comments_photo on public.photo_comments (photo_id, created_at);

-- Les photos de profil déjà en place entrent dans l'onglet « Photos de profil »
insert into public.profile_photos (owner_id, path, kind)
select id, avatar_path, 'avatar' from public.profiles where avatar_path is not null
on conflict (path) do nothing;

alter table public.profile_photos enable row level security;
alter table public.photo_likes enable row level security;
alter table public.photo_comments enable row level security;

-- Photos : visibles par tous les membres ; chacun ajoute les siennes ;
-- le propriétaire ou le gérant peut supprimer
drop policy if exists "Voir les photos des profils" on public.profile_photos;
create policy "Voir les photos des profils" on public.profile_photos
  for select to authenticated using (true);
drop policy if exists "Ajouter ses photos" on public.profile_photos;
create policy "Ajouter ses photos" on public.profile_photos
  for insert to authenticated
  with check (owner_id = auth.uid() and not public.is_blocked() and public.terms_ok());
drop policy if exists "Supprimer ses photos ou gérant" on public.profile_photos;
create policy "Supprimer ses photos ou gérant" on public.profile_photos
  for delete to authenticated using (owner_id = auth.uid() or public.is_admin());

-- J'aime
drop policy if exists "Voir les j'aime" on public.photo_likes;
create policy "Voir les j'aime" on public.photo_likes
  for select to authenticated using (true);
drop policy if exists "Aimer une photo" on public.photo_likes;
create policy "Aimer une photo" on public.photo_likes
  for insert to authenticated
  with check (user_id = auth.uid() and not public.is_blocked() and public.terms_ok());
drop policy if exists "Retirer son j'aime" on public.photo_likes;
create policy "Retirer son j'aime" on public.photo_likes
  for delete to authenticated using (user_id = auth.uid());

-- Commentaires : l'auteur, le propriétaire de la photo ou le gérant peut supprimer
drop policy if exists "Voir les commentaires" on public.photo_comments;
create policy "Voir les commentaires" on public.photo_comments
  for select to authenticated using (true);
drop policy if exists "Commenter" on public.photo_comments;
create policy "Commenter" on public.photo_comments
  for insert to authenticated
  with check (user_id = auth.uid() and not public.is_blocked() and public.terms_ok());
drop policy if exists "Supprimer un commentaire" on public.photo_comments;
create policy "Supprimer un commentaire" on public.photo_comments
  for delete to authenticated
  using (user_id = auth.uid() or public.is_admin()
         or exists (select 1 from public.profile_photos p where p.id = photo_id and p.owner_id = auth.uid()));

-- Le gérant peut aussi effacer le fichier d'une photo de profil
drop policy if exists "Le gérant supprime les photos de profil" on storage.objects;
create policy "Le gérant supprime les photos de profil" on storage.objects
  for delete to authenticated using (bucket_id = 'avatars' and public.is_admin());

-- Les photos de profil peuvent faire jusqu'à 5 Mo
update storage.buckets set file_size_limit = 5242880 where id = 'avatars';
