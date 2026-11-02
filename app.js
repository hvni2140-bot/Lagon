// Lagon — messagerie de groupe et privée avec photos et vidéos.
// Les données sont dans Supabase ; les règles d'accès de la base
// (voir supabase.sql) protègent les discussions privées.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const $ = (id) => document.getElementById(id);
const cfg = window.LAGON_CONFIG || {};
const MAX_FILE = 50 * 1024 * 1024; // 50 Mo, même limite que le stockage
let sb;

const S = {
  me: null,                 // profil connecté
  profiles: new Map(),      // id -> profil
  convs: [],                // discussions visibles
  current: null,            // id de la discussion ouverte
  msgs: new Map(),          // conversation -> messages (ordre chronologique)
  last: new Map(),          // conversation -> dernier message
  unread: new Set(),
  sel: null, confirm: null,
  view: "chat",
};
const nodes = new Map();
const urlCache = new Map();
let pending = null, stickBottom = true, confirmTimer = null, toastTimer = null, entering = false, channel = null;

/* ---------- utilitaires ---------- */
function toast(t) { const e = $("toast"); e.textContent = t; e.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (e.hidden = true), 2600); }
const nameOf = (id) => S.profiles.get(id)?.display_name || "Membre";
const initial = (n) => (n.trim()[0] || "?").toUpperCase();
const hhmm = (iso) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
function shortWhen(iso) {
  const d = new Date(iso), t = new Date();
  return d.toDateString() === t.toDateString() ? hhmm(iso) : d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}
function dayLabel(iso) {
  const d = new Date(iso), t = new Date(), y = new Date(); y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return "Aujourd'hui";
  if (d.toDateString() === y.toDateString()) return "Hier";
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
}
function fmtBytes(b) { return b >= 1e6 ? Math.round(b / 1e6) + " Mo" : Math.round(b / 1e3) + " Ko"; }
function convTitle(c) {
  if (c.is_group) return c.title || "Groupe";
  if (c.mine) return nameOf(c.other);
  return c.members.map(nameOf).join(" ↔ ");
}
const findConv = (id) => S.convs.find((x) => x.id === id) || (S.otherConvs || []).find((x) => x.id === id);
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

// Photo de profil : un rond avec l'initiale, remplacé par la photo quand elle existe.
function fillAvatar(box, id) {
  const p = S.profiles.get(id), name = (p && p.display_name) || "?";
  box.textContent = initial(name);
  box.style.backgroundImage = "";
  box.classList.remove("photo");
  if (p && p.avatar_path) {
    signedUrl("avatars", p.avatar_path).then((u) => {
      const now = S.profiles.get(id); if (!now || now.avatar_path !== p.avatar_path) return;
      box.style.backgroundImage = `url("${u}")`; box.textContent = ""; box.classList.add("photo");
    }).catch(() => {});
  }
  return box;
}
const avatar = (id, extra = "") => fillAvatar(el("div", "av" + extra), id);

/* ---------- démarrage ---------- */
if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("VOTRE-PROJET") || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_ANON_KEY.includes("VOTRE")) {
  $("setup").hidden = false;
} else {
  start();
}

async function start() {
  sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") showAuth();
    else if (session && !S.me) enter(session);
  });
  const { data: { session } } = await sb.auth.getSession();
  if (session) enter(session); else showAuth();
}

/* ---------- connexion ---------- */
// Les comptes sont créés par le gérant. Un identifiant simple ("teva")
// correspond à une adresse technique interne : aucun email n'est envoyé.
const LOGIN_DOMAIN = "lagon.example.com";
const toEmail = (login) => (login.includes("@") ? login : login + "@" + LOGIN_DOMAIN).toLowerCase();

function authError(msg) {
  const m = (msg || "").toLowerCase();
  if (m.includes("invalid login")) return "Identifiant ou mot de passe incorrect.";
  if (m.includes("rate limit")) return "Trop de tentatives. Réessayez dans quelques minutes.";
  return "Connexion impossible : " + msg;
}

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const login = $("auth-login").value.trim(), password = $("auth-pass").value;
  const err = $("auth-err"); err.hidden = true;
  if (!login || !password) { err.textContent = "Indiquez votre identifiant et votre mot de passe."; err.hidden = false; return; }
  const btn = $("auth-submit"); btn.disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email: toEmail(login), password });
  if (error) { err.textContent = authError(error.message); err.hidden = false; }
  btn.disabled = false;
});

function showTerms() {
  $("auth").hidden = true; $("app").hidden = true; $("terms").hidden = false;
  $("terms-check").checked = false; $("terms-accept").disabled = true;
}
$("terms-check").addEventListener("change", () => { $("terms-accept").disabled = !$("terms-check").checked; });
$("terms-refuse").onclick = () => { $("terms").hidden = true; sb.auth.signOut(); };
$("terms-accept").onclick = async () => {
  const btn = $("terms-accept"), err = $("terms-err"); btn.disabled = true; err.hidden = true;
  const { error } = await sb.rpc("accept_terms");
  if (error) { err.textContent = "L'acceptation n'a pas pu être enregistrée. Réessayez."; err.hidden = false; btn.disabled = false; return; }
  $("terms").hidden = true;
  const { data: { session } } = await sb.auth.getSession();
  S.me = null; entering = false; if (session) enter(session);
};

function showAuth() {
  $("terms").hidden = true;
  S.me = null; entering = false;
  if (channel) { sb.removeChannel(channel); channel = null; }
  $("app").hidden = true; $("auth").hidden = false;
}

async function enter(session) {
  if (entering) return; entering = true;
  const { data: me, error } = await sb.from("profiles").select("*").eq("id", session.user.id).single();
  if (error || !me) { entering = false; toast("Profil introuvable. Reconnectez-vous."); await sb.auth.signOut(); return; }
  S.me = me;
  if (!me.terms_accepted_at) { showTerms(); return; }
  await loadProfiles();
  await loadConvs();
  subscribe();
  $("auth").hidden = true; $("app").hidden = false;
  renderMe();
  $("btn-admin").hidden = !me.is_admin;
  const group = S.convs.find((c) => c.is_group);
  if (group && matchMedia("(min-width: 761px)").matches) openConv(group.id);
  else showList();
}

$("btn-logout").onclick = () => sb.auth.signOut();

/* ---------- chargement ---------- */
async function loadProfiles() {
  const { data } = await sb.from("profiles").select("*").order("display_name");
  S.profiles = new Map((data || []).map((p) => [p.id, p]));
  if (S.me && S.profiles.has(S.me.id)) S.me = S.profiles.get(S.me.id);
}

async function loadConvs() {
  const { data, error } = await sb.from("conversations").select("id,is_group,title,created_at,conversation_members(user_id)");
  if (error) { toast("Impossible de charger les discussions."); return; }
  const all = (data || []).map((c) => {
    const members = c.conversation_members.map((m) => m.user_id);
    return { ...c, members, mine: c.is_group || members.includes(S.me.id),
      other: c.is_group ? null : members.find((id) => id !== S.me.id) };
  });
  S.convs = all.filter((c) => c.mine);
  S.otherConvs = all.filter((c) => !c.mine); // visibles par le gérant seulement
  await Promise.all(S.convs.filter((c) => !S.last.has(c.id)).map(async (c) => {
    const { data } = await sb.from("messages").select("*").eq("conversation_id", c.id).order("created_at", { ascending: false }).limit(1);
    if (data && data[0]) S.last.set(c.id, data[0]);
  }));
  renderConvs();
}

async function loadMessages(cid) {
  const { data, error } = await sb.from("messages").select("*").eq("conversation_id", cid).order("created_at", { ascending: false }).limit(300);
  if (error) { toast("Impossible de charger les messages."); return; }
  S.msgs.set(cid, (data || []).reverse());
}

/* ---------- temps réel ---------- */
function subscribe() {
  channel = sb.channel("lagon-messages")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (p) => onInsert(p.new))
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages" }, (p) => onDelete(p.old))
    .subscribe();
}

async function onInsert(m) {
  if (!findConv(m.conversation_id)) await loadConvs();
  if (!S.profiles.has(m.sender_id)) await loadProfiles();
  addMessage(m);
  const mine = S.convs.some((c) => c.id === m.conversation_id);
  if (mine && m.sender_id !== S.me.id && (m.conversation_id !== S.current || document.hidden || S.view !== "chat")) S.unread.add(m.conversation_id);
  renderConvs();
  if (m.conversation_id === S.current) renderThread();
}

function addMessage(m) {
  const list = S.msgs.get(m.conversation_id);
  if (list && !list.some((x) => x.id === m.id)) list.push(m);
  const last = S.last.get(m.conversation_id);
  if (!last || last.created_at <= m.created_at) S.last.set(m.conversation_id, m);
}

function removeMessage(id) {
  for (const [cid, list] of S.msgs) {
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) { list.splice(i, 1); if (S.last.get(cid)?.id === id) { if (list.length) S.last.set(cid, list[list.length - 1]); else S.last.delete(cid); } }
  }
  for (const [cid, m] of S.last) if (m.id === id) S.last.delete(cid);
}

function onDelete(old) {
  if (!old || !old.id) return;
  removeMessage(old.id);
  renderConvs();
  if (S.current) renderThread();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && S.current && S.view === "chat") { S.unread.delete(S.current); renderConvs(); }
});

/* ---------- liste des discussions ---------- */
function renderConvs() {
  const list = $("conv-list"); list.replaceChildren();
  const sorted = [...S.convs].sort((a, b) => {
    if (a.is_group !== b.is_group) return a.is_group ? -1 : 1;
    const ta = S.last.get(a.id)?.created_at || a.created_at, tb = S.last.get(b.id)?.created_at || b.created_at;
    return tb.localeCompare(ta);
  });
  for (const c of sorted) {
    const b = el("button", "conv"); b.type = "button";
    if (c.id === S.current) b.setAttribute("aria-current", "true");
    const title = convTitle(c);
    const av = c.is_group ? el("div", "av group", "#") : avatar(c.other);
    const mid = el("div", "grow");
    const nm = el("div", "name", title);
    if (!c.is_group) nm.insertAdjacentHTML("beforeend", '<svg class="lock" viewBox="0 0 24 24" fill="currentColor" aria-label="Privée"><path d="M6 10V8a6 6 0 1 1 12 0v2h1v12H5V10zm2 0h8V8a4 4 0 1 0-8 0z"/></svg>');
    const last = S.last.get(c.id);
    let prev = c.is_group ? "Discussion avec tous les membres" : "Discussion privée";
    if (last) {
      const who = last.sender_id === S.me.id ? "Vous : " : c.is_group ? nameOf(last.sender_id) + " : " : "";
      prev = who + (last.body || (last.media_kind === "video" ? "Vidéo" : "Photo"));
    }
    mid.append(nm, el("div", "prev", prev));
    b.append(av, mid);
    if (last) b.append(el("span", "time", shortWhen(last.created_at)));
    if (S.unread.has(c.id)) b.append(el("span", "dot"));
    b.onclick = () => openConv(c.id);
    list.append(b);
  }
  const n = S.unread.size; document.title = n ? `(${n}) Lagon` : "Lagon";
}

/* ---------- navigation ---------- */
function showView(v) {
  S.view = v;
  $("chat").hidden = v !== "chat"; $("picker").hidden = v !== "picker"; $("admin").hidden = v !== "admin"; $("profile").hidden = v !== "profile";
  $("app").classList.add("in-chat");
}
function showList() { $("app").classList.remove("in-chat"); }
$("btn-back").onclick = showList;
function backFromPanel() { if (S.current) showView("chat"); else { showView("chat"); showList(); } }
$("picker-back").onclick = backFromPanel;
$("admin-back").onclick = backFromPanel;
$("profile-back").onclick = backFromPanel;

async function openConv(cid) {
  if (S.current !== cid) { nodes.clear(); $("thread").replaceChildren(); S.sel = null; S.confirm = null; }
  S.current = cid; S.unread.delete(cid); stickBottom = true;
  showView("chat");
  const c = findConv(cid); if (!c) return;
  const title = convTitle(c);
  $("chat-title").textContent = title;
  $("chat-av").className = "av" + (c.is_group ? " group" : "");
  if (c.is_group) { $("chat-av").style.backgroundImage = ""; $("chat-av").textContent = "#"; } else fillAvatar($("chat-av"), c.other);
  $("chat-sub").textContent = c.is_group ? S.profiles.size + (S.profiles.size > 1 ? " membres" : " membre")
    : !c.mine ? "Lecture seule · discussion privée entre membres"
    : "Discussion privée";
  const blocked = S.me.blocked, readonly = !c.mine;
  $("composer").hidden = blocked || readonly; $("blocked-note").hidden = !blocked || readonly; $("readonly-note").hidden = !readonly;
  renderConvs();
  if (!S.msgs.has(cid)) { $("thread").replaceChildren(Object.assign(el("div", "empty"), { innerHTML: "<b>Chargement…</b>" })); await loadMessages(cid); }
  if (S.current === cid) renderThread();
}

/* ---------- messages ---------- */
async function signedUrl(bucket, path) {
  const key = bucket + "/" + path, hit = urlCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.url;
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, 3600);
  if (error) throw error;
  urlCache.set(key, { url: data.signedUrl, exp: Date.now() + 50 * 60 * 1000 });
  return data.signedUrl;
}
const mediaUrl = (path) => signedUrl("media", path);

function atBottom() { const s = $("scroll"); return s.scrollHeight - s.scrollTop - s.clientHeight < 80; }
function keepBottom() { if (stickBottom) $("scroll").scrollTop = $("scroll").scrollHeight; }
$("scroll").addEventListener("scroll", () => { stickBottom = atBottom(); }, { passive: true });

function buildMsg(m) {
  const w = el("div", "msg new");
  const who = el("div", "who");
  const bub = el("button", "bub"); bub.type = "button";
  if (m.media_path) {
    const media = m.media_kind === "video" ? document.createElement("video") : document.createElement("img");
    if (m.media_kind === "video") { media.controls = true; media.preload = "metadata"; media.playsInline = true; media.addEventListener("loadedmetadata", keepBottom); }
    else { media.alt = m.body ? m.body.slice(0, 120) : "Photo"; media.addEventListener("load", keepBottom); }
    mediaUrl(m.media_path).then((u) => (media.src = u)).catch(() => { media.replaceWith(el("span", "txt", "Média indisponible")); });
    bub.append(media);
  }
  if (m.body) bub.append(el("span", "txt", m.body));
  const meta = el("div", "meta");
  const tools = el("div", "tools");
  const del = el("button"); del.type = "button"; tools.append(del);
  w.append(who, bub, meta, tools);
  bub.onclick = () => { S.sel = S.sel === m.id ? null : m.id; S.confirm = null; renderThread(); };
  del.onclick = () => {
    if (S.confirm === m.id) { S.confirm = null; S.sel = null; deleteMsg(m); }
    else { S.confirm = m.id; clearTimeout(confirmTimer); confirmTimer = setTimeout(() => { S.confirm = null; renderThread(); }, 4000); renderThread(); }
  };
  w._r = { who, meta, tools, del };
  setTimeout(() => w.classList.remove("new"), 300);
  return w;
}

function renderThread() {
  const cid = S.current, list = S.msgs.get(cid); if (!list) return;
  const c = findConv(cid);
  const th = $("thread"), out = [], seen = new Set();
  let lastDay = null, prev = null;
  for (const m of list) {
    const day = dayLabel(m.created_at);
    if (day !== lastDay) {
      const k = "day:" + day; let n = nodes.get(k);
      if (!n) { n = el("div", "day", day); nodes.set(k, n); }
      seen.add(k); out.push(n); lastDay = day; prev = null;
    }
    seen.add(m.id);
    let n = nodes.get(m.id); if (!n) { n = buildMsg(m); nodes.set(m.id, n); }
    const own = m.sender_id === S.me.id;
    const first = !prev || prev.sender_id !== m.sender_id || Date.parse(m.created_at) - Date.parse(prev.created_at) > 5 * 60000;
    n.classList.toggle("mine", own); n.classList.toggle("first", first);
    const r = n._r, selected = S.sel === m.id;
    r.who.hidden = own || !first || !(c?.is_group || !c?.mine);
    if (!r.who.hidden) { r.who.replaceChildren(avatar(m.sender_id, " mini"), el("span", null, nameOf(m.sender_id))); }
    r.meta.textContent = hhmm(m.created_at); r.meta.hidden = !(first || selected);
    const canDel = own || S.me.is_admin;
    r.tools.hidden = !(selected && canDel);
    const armed = S.confirm === m.id;
    r.del.className = armed ? "danger" : ""; r.del.textContent = armed ? "Confirmer la suppression" : "Supprimer";
    out.push(n); prev = m;
  }
  for (const k of [...nodes.keys()]) if (!seen.has(k)) nodes.delete(k);
  if (!out.length) {
    const e = el("div", "empty");
    e.innerHTML = c?.is_group
      ? "<b>Le groupe est vide</b>Écrivez le premier message ou envoyez une photo avec le bouton image."
      : "<b>Nouvelle discussion privée</b>Écrivez le premier message.";
    th.replaceChildren(e); return;
  }
  const cur = [...th.children];
  if (cur.length !== out.length || cur.some((n, i) => n !== out[i])) th.replaceChildren(...out);
  keepBottom();
}

async function deleteMsg(m) {
  const { data, error } = await sb.from("messages").delete().eq("id", m.id).select("id");
  if (error || !data || !data.length) { toast("Suppression impossible."); return; }
  removeMessage(m.id); renderConvs(); renderThread(); toast("Message supprimé");
  if (m.media_path && (m.sender_id === S.me.id || S.me.is_admin)) sb.storage.from("media").remove([m.media_path]);
}

/* ---------- envoi ---------- */
const text = $("text");
function updateSend() { $("send").disabled = !(text.value.trim() || pending); }
function grow() { text.style.height = "auto"; text.style.height = Math.min(text.scrollHeight, 120) + "px"; }
text.addEventListener("input", () => { grow(); updateSend(); });
text.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(hover: hover)").matches) { e.preventDefault(); if (!$("send").disabled) send(); }
});
function showErr(t) { $("cerr").textContent = t; $("cerr").hidden = !t; }
function clearAttach() { pending = null; $("file").value = ""; $("attach").hidden = true; $("attach").replaceChildren(); updateSend(); }

$("file").addEventListener("change", () => {
  const f = $("file").files[0]; showErr(""); if (!f) return;
  if (!/^(image|video)\//.test(f.type)) { showErr("Choisissez une photo ou une vidéo."); $("file").value = ""; return; }
  const isPhoto = f.type.startsWith("image/") && f.type !== "image/gif";
  if (!isPhoto && f.size > MAX_FILE) { showErr("Ce fichier fait " + fmtBytes(f.size) + ". La limite est de 50 Mo : raccourcissez la vidéo."); $("file").value = ""; return; }
  pending = f;
  const url = URL.createObjectURL(f);
  const prev = f.type.startsWith("video/") ? Object.assign(document.createElement("video"), { src: url, muted: true, playsInline: true }) : Object.assign(document.createElement("img"), { src: url, alt: "Aperçu" });
  const lbl = el("span", null, (f.type.startsWith("video/") ? "Vidéo" : "Photo") + " · " + fmtBytes(f.size));
  const x = el("button", null, "Retirer"); x.type = "button"; x.onclick = clearAttach;
  $("attach").replaceChildren(prev, lbl, x); $("attach").hidden = false; updateSend(); text.focus();
});

// Réduit une photo à 1600 pixels maximum (côté le plus long), en JPEG qualité 80 %.
function compressPhoto(file) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("conversion"))), "image/jpeg", 0.8);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("lecture")); };
    img.src = url;
  });
}

async function send() {
  const cid = S.current, body = text.value.trim().slice(0, 2000), f = pending;
  if (!cid || (!body && !f)) return;
  $("send").disabled = true; showErr("");
  try {
    const row = { conversation_id: cid };
    if (body) row.body = body;
    if (f) {
      $("attach").querySelector("span").textContent = "Envoi en cours…";
      // Les photos sont compressées avant l'envoi (≈ 10 fois plus légères)
      let file = f, type = f.type;
      if (f.type.startsWith("image/") && f.type !== "image/gif") {
        try { const small = await compressPhoto(f); if (small.size < f.size) { file = small; type = "image/jpeg"; } } catch {}
      }
      if (file.size > MAX_FILE) throw new Error("Fichier trop lourd (50 Mo maximum).");
      const ext = type === "image/jpeg" && file !== f ? "jpg" : ((f.name.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || (f.type.split("/")[1] || "bin"));
      const path = `${cid}/${crypto.randomUUID()}.${ext}`;
      const { error } = await sb.storage.from("media").upload(path, file, { contentType: type, upsert: false });
      if (error) throw new Error(/size|large/i.test(error.message) ? "Fichier trop lourd (50 Mo maximum)." : "L'envoi du fichier a échoué. Réessayez.");
      row.media_path = path; row.media_kind = f.type.startsWith("video/") ? "video" : "image";
    }
    const { data, error } = await sb.from("messages").insert(row).select().single();
    if (error) throw new Error(S.me.blocked ? "Votre compte est bloqué." : "Le message n'a pas pu être envoyé. Réessayez.");
    text.value = ""; grow(); clearAttach(); stickBottom = true;
    addMessage(data); renderConvs(); if (S.current === cid) renderThread();
  } catch (e) {
    showErr(e.message || "L'envoi a échoué. Vérifiez votre connexion.");
    if (pending) $("attach").querySelector("span").textContent = "Prêt à renvoyer";
  }
  updateSend();
}
$("send").addEventListener("click", send);

/* ---------- nouvelle discussion privée ---------- */
$("btn-new").onclick = async () => { await loadProfiles(); $("picker-search").value = ""; renderPicker(); showView("picker"); $("picker-search").focus(); };
$("picker-search").addEventListener("input", renderPicker);
function renderPicker() {
  const q = $("picker-search").value.trim().toLowerCase();
  const list = $("picker-list"); list.replaceChildren();
  const people = [...S.profiles.values()].filter((p) => p.id !== S.me.id && p.display_name.toLowerCase().includes(q));
  if (!people.length) { list.append(el("div", "row muted", q ? "Aucun membre ne correspond." : "Aucun autre membre pour l'instant. Invitez des personnes à créer un compte.")); return; }
  for (const p of people) {
    const b = el("button", "row"); b.type = "button";
    b.append(avatar(p.id), el("div", "grow", p.display_name));
    b.onclick = async () => {
      b.disabled = true;
      const { data, error } = await sb.rpc("open_dm", { other: p.id });
      if (error) { toast("Impossible d'ouvrir la discussion."); b.disabled = false; return; }
      await loadConvs(); openConv(data);
    };
    list.append(b);
  }
}

/* ---------- gestion ---------- */
// Création des comptes et des mots de passe : passe par la fonction
// serveur "gerer-membres" (Supabase Edge Function), réservée au gérant.
function newPassword() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  const a = new Uint32Array(8); crypto.getRandomValues(a);
  return [...a].map((n) => chars[n % chars.length]).join("");
}

async function callAdmin(body) {
  const { data, error } = await sb.functions.invoke("gerer-membres", { body });
  if (error) {
    let msg = "Le service de gestion ne répond pas. Vérifiez que la fonction « gerer-membres » est bien installée.";
    try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return data;
}

function showCreds(name, login, password, title) {
  const box = $("creds");
  box.replaceChildren();
  box.append(el("b", null, title));
  const txt = `Lagon : https://hvni2140-bot.github.io/Lagon/\nIdentifiant : ${login}\nMot de passe : ${password}`;
  const pre = el("pre", "creds-text", txt);
  const copy = el("button", "btn", "Copier pour l'envoyer à " + name); copy.type = "button";
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(txt); toast("Copié"); }
    catch { const r = document.createRange(); r.selectNodeContents(pre); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
  };
  box.append(pre, el("span", "muted small", "Notez-le maintenant : le mot de passe ne sera plus affiché ensuite."), copy);
  box.hidden = false;
  box.scrollIntoView({ behavior: "smooth", block: "center" });
}

$("nm-gen").onclick = () => { $("nm-pass").value = newPassword(); };
$("new-member").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("nm-name").value.trim(), login = $("nm-login").value.trim().toLowerCase(), password = $("nm-pass").value.trim();
  const err = $("nm-err"); err.hidden = true;
  if (!name || !/^[a-z0-9._-]{3,30}$/.test(login) || password.length < 6) {
    err.textContent = "Indiquez un nom, un identifiant de 3 à 30 caractères (lettres sans accent, chiffres, . _ -) et un mot de passe d'au moins 6 caractères.";
    err.hidden = false; return;
  }
  const btn = $("nm-submit"); btn.disabled = true; btn.textContent = "Création…";
  try {
    await callAdmin({ action: "create", name, login, password });
    $("new-member").reset();
    showCreds(name, login, password, "Compte créé pour " + name);
    await loadProfiles(); renderAdmin(true);
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  btn.disabled = false; btn.textContent = "Créer le compte";
});

$("btn-admin").onclick = async () => { await loadProfiles(); $("creds").hidden = true; renderAdmin(); admTab("members"); showView("admin"); };

function admTab(t) {
  for (const k of ["members", "gallery", "convs"]) {
    $("adm-tab-" + k).setAttribute("aria-selected", k === t);
    $("adm-" + k).hidden = k !== t;
  }
  if (t === "gallery") renderGallery();
  if (t === "convs") renderAllConvs();
}
$("adm-tab-members").onclick = () => admTab("members");
$("adm-tab-gallery").onclick = () => admTab("gallery");
$("adm-tab-convs").onclick = () => admTab("convs");

async function renderGallery() {
  const g = $("gallery");
  g.replaceChildren(el("p", "muted small", "Chargement…"));
  await loadConvs();
  const { data, error } = await sb.from("messages").select("id,conversation_id,sender_id,media_path,media_kind,created_at")
    .not("media_path", "is", null).order("created_at", { ascending: false }).limit(200);
  if (error) { g.replaceChildren(el("p", "err", "La galerie n'a pas pu être chargée.")); return; }
  if (!data.length) { g.replaceChildren(el("p", "muted", "Aucune photo ni vidéo envoyée pour l'instant.")); return; }
  g.replaceChildren();
  for (const m of data) {
    const c = findConv(m.conversation_id);
    const tile = el("button", "tile"); tile.type = "button";
    const media = m.media_kind === "video" ? Object.assign(document.createElement("video"), { muted: true, playsInline: true, preload: "metadata" }) : Object.assign(document.createElement("img"), { alt: "Photo de " + nameOf(m.sender_id), loading: "lazy" });
    mediaUrl(m.media_path).then((u) => (media.src = m.media_kind === "video" ? u + "#t=0.1" : u)).catch(() => {});
    tile.append(media);
    if (m.media_kind === "video") tile.append(el("span", "play", "▶"));
    const cap = el("span", "tile-cap");
    cap.append(el("b", null, nameOf(m.sender_id)), el("span", null, (c ? (c.is_group ? "Groupe" : convTitle(c)) : "") + " · " + shortWhen(m.created_at)));
    tile.append(cap);
    tile.onclick = () => { if (c) openConv(c.id); };
    g.append(tile);
  }
}

async function renderAllConvs() {
  const list = $("all-convs");
  list.replaceChildren(el("div", "row muted", "Chargement…"));
  await loadConvs();
  const dms = [...S.convs.filter((c) => !c.is_group), ...(S.otherConvs || [])];
  list.replaceChildren();
  if (!dms.length) { list.append(el("div", "row muted", "Aucune discussion privée pour l'instant.")); return; }
  for (const c of dms) {
    const b = el("button", "row"); b.type = "button";
    const avs = el("div", "pair");
    for (const id of c.members.slice(0, 2)) avs.append(avatar(id, " mini2"));
    b.append(avs, el("div", "grow", c.members.map(nameOf).join(" ↔ ")));
    b.onclick = () => openConv(c.id);
    list.append(b);
  }
}
function renderAdmin() {
  const list = $("admin-list"); list.replaceChildren();
  for (const p of S.profiles.values()) {
    const row = el("div", "row");
    const who = el("div", "grow");
    const sub = p.login ? "Identifiant : " + p.login : "Connexion par email";
    who.append(el("b", null, p.display_name + (p.id === S.me.id ? " (vous)" : "")), document.createElement("br"), el("span", "muted small", sub));
    row.append(avatar(p.id), who);
    if (p.is_admin) row.append(el("span", "chip admin", "Gérant"));
    if (p.blocked) row.append(el("span", "chip", "Bloqué"));
    if (p.id !== S.me.id) {
      const pw = el("button", "btn soft", "Nouveau mot de passe"); pw.type = "button";
      pw.onclick = async () => {
        if (pw.dataset.armed !== "1") { pw.dataset.armed = "1"; pw.textContent = "Confirmer"; pw.classList.add("danger"); setTimeout(() => { pw.dataset.armed = ""; pw.textContent = "Nouveau mot de passe"; pw.classList.remove("danger"); }, 4000); return; }
        pw.disabled = true;
        const password = newPassword();
        try { await callAdmin({ action: "reset_password", user_id: p.id, password }); showCreds(p.display_name, p.login || "(son email)", password, "Nouveau mot de passe pour " + p.display_name); }
        catch (ex) { toast(ex.message); }
        pw.disabled = false; pw.dataset.armed = ""; pw.textContent = "Nouveau mot de passe"; pw.classList.remove("danger");
      };
      const b = el("button", "btn soft", p.blocked ? "Débloquer" : "Bloquer"); b.type = "button";
      b.onclick = async () => {
        b.disabled = true;
        const { error } = await sb.rpc("set_blocked", { target: p.id, value: !p.blocked });
        if (error) { toast("Action impossible."); b.disabled = false; return; }
        await loadProfiles(); renderAdmin(); toast(p.blocked ? "Membre débloqué" : "Membre bloqué");
      };
      row.append(pw, b);
    }
    list.append(row);
  }
}

/* ---------- mon profil ---------- */
function renderMe() {
  $("me-name").textContent = S.me.display_name + (S.me.is_admin ? " · gérant" : "");
  fillAvatar($("me-av"), S.me.id);
}
function renderProfile() {
  fillAvatar($("pf-av"), S.me.id);
  $("pf-name").value = S.me.display_name;
  $("pf-remove").hidden = !S.me.avatar_path;
  $("pf-err").hidden = true;
}
$("btn-me").onclick = async () => { await loadProfiles(); renderProfile(); showView("profile"); };

// Réduit la photo à 400 × 400 (carré centré) pour un envoi rapide.
function squareJpeg(file) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight), size = Math.min(400, side);
      const c = document.createElement("canvas"); c.width = c.height = size;
      c.getContext("2d").drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("conversion"))), "image/jpeg", 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("lecture")); };
    img.src = url;
  });
}

async function setAvatar(path) {
  const old = S.me.avatar_path;
  const { error } = await sb.from("profiles").update({ avatar_path: path }).eq("id", S.me.id);
  if (error) throw error;
  if (old && old !== path) sb.storage.from("avatars").remove([old]);
  await loadProfiles(); renderMe(); renderProfile(); renderConvs();
  if (S.current) { nodes.clear(); $("thread").replaceChildren(); renderThread(); }
}

$("pf-file").addEventListener("change", async () => {
  const f = $("pf-file").files[0]; $("pf-file").value = ""; if (!f) return;
  const err = $("pf-err"); err.hidden = true;
  if (!f.type.startsWith("image/")) { err.textContent = "Choisissez une photo."; err.hidden = false; return; }
  $("pf-pick-label").textContent = "Envoi…";
  try {
    const blob = await squareJpeg(f);
    const path = `${S.me.id}/${Date.now()}.jpg`;
    const up = await sb.storage.from("avatars").upload(path, blob, { contentType: "image/jpeg" });
    if (up.error) throw up.error;
    await setAvatar(path); toast("Photo de profil mise à jour");
  } catch { err.textContent = "La photo n'a pas pu être enregistrée. Essayez une autre image."; err.hidden = false; }
  $("pf-pick-label").textContent = "Changer la photo";
});
$("pf-remove").onclick = async () => {
  try { await setAvatar(null); toast("Photo retirée"); } catch { toast("Action impossible."); }
};
$("pf-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("pf-name").value.trim(), err = $("pf-err"); err.hidden = true;
  if (!name || name.length > 40) { err.textContent = "Le nom doit faire entre 1 et 40 caractères."; err.hidden = false; return; }
  const { error } = await sb.from("profiles").update({ display_name: name }).eq("id", S.me.id);
  if (error) { err.textContent = "Le nom n'a pas pu être enregistré."; err.hidden = false; return; }
  await loadProfiles(); renderMe(); renderConvs(); toast("Nom enregistré");
});
