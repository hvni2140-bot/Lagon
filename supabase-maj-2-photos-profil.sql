-- ============================================================
-- Lagon : mise à jour 2 — photos de profil
-- À coller dans Supabase > SQL Editor > Run (une seule fois)
-- ============================================================

-- Chemin de la photo de chaque membre (toujours dans son propre dossier)
alter table public.profiles add column if not exists avatar_path text;
alter table public.profiles drop constraint if exists avatar_dans_son_dossier;
alter table public.profiles add constraint avatar_dans_son_dossier
  check (avatar_path is null or avatar_path like id::text || '/%');

-- Chaque membre peut modifier son nom et sa photo (rien d'autre)
grant update (display_name, avatar_path) on public.profiles to authenticated;

-- Espace de stockage des photos de profil (2 Mo max, images seulement)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "Voir les photos de profil" on storage.objects;
drop policy if exists "Ajouter sa photo de profil" on storage.objects;
drop policy if exists "Supprimer sa photo de profil" on storage.objects;

create policy "Voir les photos de profil" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars');
create policy "Ajouter sa photo de profil" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (auth.uid())::text);
create policy "Supprimer sa photo de profil" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (auth.uid())::text);
