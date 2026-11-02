-- ============================================================
-- Sunset : mise à jour 4 — fiches des membres
-- Les membres ne voient plus que le nom, la photo et le rôle des autres.
-- Identifiant de connexion, blocage et date d'acceptation : réservés
-- au membre lui-même et au gérant.
-- ============================================================

revoke select on public.profiles from anon, authenticated;
grant select (id, display_name, avatar_path, is_admin, created_at) on public.profiles to authenticated;

create or replace function public.my_profile() returns setof public.profiles
language sql stable security definer set search_path = public as $$
  select * from profiles where id = auth.uid()
$$;

create or replace function public.admin_profiles() returns setof public.profiles
language sql stable security definer set search_path = public as $$
  select * from profiles where public.is_admin() order by display_name
$$;

revoke execute on function public.my_profile(), public.admin_profiles() from anon, public;
grant execute on function public.my_profile(), public.admin_profiles() to authenticated;
