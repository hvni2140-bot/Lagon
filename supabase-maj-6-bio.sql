-- Sunset : mise à jour 6 — bio des membres
alter table public.profiles add column if not exists bio text check (char_length(bio) <= 500);
grant select (bio) on public.profiles to authenticated;
grant update (display_name, avatar_path, bio) on public.profiles to authenticated;
