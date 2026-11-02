// Fonction serveur « gerer-membres » de Lagon (Supabase Edge Function).
// Permet au gérant, et à lui seul, de créer des comptes et de changer
// le mot de passe d'un membre. La clé secrète reste sur le serveur.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const LOGIN_DOMAIN = "lagon.example.com"; // adresse technique, aucun email n'est envoyé
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // 1. Qui appelle ? Seul le gérant est autorisé.
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user }, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !user) return json({ error: "Vous n'êtes pas connecté." }, 401);
    const { data: me } = await admin.from("profiles").select("is_admin").eq("id", user.id).single();
    if (!me?.is_admin) return json({ error: "Action réservée au gérant." }, 403);

    const body = await req.json().catch(() => ({}));
    const password = String(body.password || "");
    if (password.length < 6) return json({ error: "Le mot de passe doit faire au moins 6 caractères." }, 400);

    // 2. Créer un membre
    if (body.action === "create") {
      const name = String(body.name || "").trim().slice(0, 40);
      const login = String(body.login || "").trim().toLowerCase();
      if (!name) return json({ error: "Indiquez le nom du membre." }, 400);
      if (!/^[a-z0-9._-]{3,30}$/.test(login)) {
        return json({ error: "Identifiant invalide : 3 à 30 caractères, lettres sans accent, chiffres, . _ -" }, 400);
      }
      const { error } = await admin.auth.admin.createUser({
        email: `${login}@${LOGIN_DOMAIN}`,
        password,
        email_confirm: true,
        user_metadata: { display_name: name },
      });
      if (error) {
        const taken = /already|exists|registered/i.test(error.message);
        return json({ error: taken ? "Cet identifiant est déjà utilisé." : "Création impossible : " + error.message }, taken ? 409 : 400);
      }
      return json({ ok: true });
    }

    // 3. Donner un nouveau mot de passe
    if (body.action === "reset_password") {
      const id = String(body.user_id || "");
      if (!id || id === user.id) return json({ error: "Membre invalide." }, 400);
      const { error } = await admin.auth.admin.updateUserById(id, { password });
      if (error) return json({ error: "Changement impossible : " + error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "Action inconnue." }, 400);
  } catch (_e) {
    return json({ error: "Erreur du serveur. Réessayez." }, 500);
  }
});
