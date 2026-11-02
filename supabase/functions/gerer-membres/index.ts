// Fonction serveur « gerer-membres » de Lagon (Supabase Edge Function).
// Réservée au gérant : créer un compte, donner un nouveau mot de passe.
// Réglage : « Verify JWT with legacy secret » désactivé (la vérification est faite ci-dessous).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
const H = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...H, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: H });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const u = await sb.auth.getUser(token);
    if (u.error || !u.data.user) return out({ error: "Vous n'êtes pas connecté." }, 401);
    const me = await sb.from("profiles").select("is_admin").eq("id", u.data.user.id).single();
    if (!me.data || !me.data.is_admin) return out({ error: "Action réservée au gérant." }, 403);
    const b = await req.json();
    const pw = String(b.password || "");
    if (pw.length < 6) return out({ error: "Mot de passe trop court (6 caractères minimum)." }, 400);
    if (b.action === "create") {
      const name = String(b.name || "").trim().slice(0, 40);
      const login = String(b.login || "").trim().toLowerCase();
      if (!name || !/^[a-z0-9._-]{3,30}$/.test(login)) return out({ error: "Nom ou identifiant invalide." }, 400);
      const r = await sb.auth.admin.createUser({ email: login + "@lagon.example.com", password: pw, email_confirm: true, user_metadata: { display_name: name } });
      if (r.error) return out({ error: /already|exists|registered/i.test(r.error.message) ? "Cet identifiant est déjà utilisé." : r.error.message }, 400);
      return out({ ok: true });
    }
    if (b.action === "reset_password") {
      if (!b.user_id || b.user_id === u.data.user.id) return out({ error: "Membre invalide." }, 400);
      const r = await sb.auth.admin.updateUserById(String(b.user_id), { password: pw });
      if (r.error) return out({ error: r.error.message }, 400);
      return out({ ok: true });
    }
    return out({ error: "Action inconnue." }, 400);
  } catch (_e) {
    return out({ error: "Erreur du serveur. Réessayez." }, 500);
  }
});
