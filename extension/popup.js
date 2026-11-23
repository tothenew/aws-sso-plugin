/**
 * Popup: an account browser, not a credential dump.
 *
 * Accounts arrive collapsed. Nothing sensitive is fetched or rendered until the
 * user clicks a specific role, at which point the service worker exchanges the
 * stored assertion for that one role's credentials.
 */

const bodyEl = document.getElementById("body");
const capturedEl = document.getElementById("captured");
const clearBtn = document.getElementById("clear");
const bannerEl = document.getElementById("banner");
const toolsEl = document.getElementById("tools");
const filterEl = document.getElementById("filter");
const toastEl = document.getElementById("toast");

const tplAccount = document.getElementById("tpl-account");
const tplRole = document.getElementById("tpl-role");
const tplCreds = document.getElementById("tpl-creds");
const tplClients = document.getElementById("tpl-clients");
const tplClientRow = document.getElementById("tpl-client-row");
const K_FORM = "clientForm";
/** "roles" (default) or "clients" (the switch-role view). Popup-local: resets on close. */
let view = "roles";
/**
 * Switch-role form. `source` is the roleArn of the issued jump role whose
 * "Switch role" button opened it; `lists` holds a separate list of client rows
 * per jump role (roleArn -> rows), so readOnly and adminUser never share rows.
 * Held in chrome.storage.session: memory only, gone when the browser closes.
 */
const emptyForm = () => ({ source: "", lists: {} });
let form = emptyForm();

// Show the filter box once scanning the list by eye stops being realistic.
const FILTER_THRESHOLD = 8;

let session = null;
let creds = {};
let ticker = null;

/** Which accounts the user has opened. Popup-local: resets on close, as it should. */
const opened = new Set();
/** Which role rows are expanded to show their credentials. */
const shown = new Set();

init();

async function init() {
  const bag = await chrome.storage.session.get(["session", "creds", K_FORM]);
  session = bag.session ?? null;
  creds = bag.creds ?? {};
  const saved = bag[K_FORM];
  form = saved?.lists ? saved : emptyForm();
  render();
}

clearBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clear" });
  session = null;
  creds = {};
  opened.clear();
  shown.clear();
  form = emptyForm();
  view = "roles";
  render();
});

filterEl.addEventListener("input", render);

// ------------------------------------------------------------------- render

function render() {
  clearInterval(ticker);
  bodyEl.textContent = "";

  if (!session) {
    capturedEl.textContent = "No session captured";
    clearBtn.hidden = true;
    toolsEl.hidden = true;
    bannerEl.hidden = true;
    bodyEl.append(empty());
    return;
  }

  clearBtn.hidden = false;

  if (session.error) {
    capturedEl.textContent = `Captured ${timeOfDay(session.capturedAt)}`;
    toolsEl.hidden = true;
    bannerEl.hidden = true;
    bodyEl.append(failure("Assertion", session.error));
    return;
  }

  const roles = session.roles ?? [];
  const groups = groupByAccount(roles);

  // Switch role is only offered from a role with issued credentials: the CLI
  // needs them as the source profile, and they carry the session name.
  if (view === "clients") {
    const src = sourceRole();
    if (src && isLive(creds[src.roleArn])) {
      capturedEl.textContent = `Switch role · ${src.roleName}`;
      toolsEl.hidden = true;
      bannerEl.hidden = true;
      bodyEl.append(clientsView(src));
      refreshPreview();
      return;
    }
    view = "roles";
  }

  capturedEl.textContent =
    `${count(roles.length, "role")} in ${count(groups.length, "account")}` +
    ` · ${timeOfDay(session.capturedAt)}`;

  renderBanner();

  toolsEl.hidden = roles.length < FILTER_THRESHOLD;
  const q = toolsEl.hidden ? "" : filterEl.value.trim().toLowerCase();

  const matched = q
    ? groups
        .map((g) => ({
          ...g,
          roles: g.roles.filter(
            (r) => r.roleName.toLowerCase().includes(q) || r.accountId.includes(q)
          ),
        }))
        .filter((g) => g.roles.length || g.accountId.includes(q))
    : groups;

  if (!matched.length) {
    bodyEl.append(note(`Nothing matches “${filterEl.value.trim()}”.`));
    return;
  }

  for (const group of matched) {
    // A filter narrow enough to be useful should show its hits, not make the
    // user open every group again.
    bodyEl.append(account(group, Boolean(q) || opened.has(group.accountId)));
  }

  tick();
  ticker = setInterval(tick, 1000);
}

function renderBanner() {
  const expiresAt = session.assertionExpiresAt;

  if (expiresAt && Date.now() >= expiresAt) {
    bannerEl.hidden = false;
    bannerEl.className = "banner warn";
    bannerEl.textContent =
      "This sign-in has expired, so new credentials cannot be issued. " +
      "Sign in to the AWS console again — anything already issued below still works.";
    return;
  }
  bannerEl.hidden = true;
}

// -------------------------------------------------------------------- groups

function groupByAccount(roles) {
  const byId = new Map();
  for (const r of roles) {
    if (!byId.has(r.accountId)) byId.set(r.accountId, []);
    byId.get(r.accountId).push(r);
  }
  return [...byId.entries()]
    .map(([accountId, rs]) => ({ accountId, roles: rs }))
    .sort((a, b) => a.accountId.localeCompare(b.accountId));
}

function account(group, isOpen) {
  const el = tplAccount.content.firstElementChild.cloneNode(true);
  const head = el.querySelector(".acct-head");
  const list = el.querySelector(".acct-roles");

  el.querySelector(".acct-id").textContent = group.accountId;
  el.querySelector(".acct-count").textContent = count(group.roles.length, "role");

  const live = group.roles.filter((r) => isLive(creds[r.roleArn])).length;
  if (live) {
    const dot = document.createElement("span");
    dot.className = "live-dot";
    dot.title = `${count(live, "role")} with credentials issued`;
    head.append(dot);
  }

  for (const r of group.roles) list.append(roleRow(r));

  const setOpen = (open) => {
    head.setAttribute("aria-expanded", String(open));
    list.hidden = !open;
    el.classList.toggle("open", open);
    if (open) opened.add(group.accountId);
    else opened.delete(group.accountId);
  };
  setOpen(isOpen);

  head.addEventListener("click", () => setOpen(list.hidden));
  return el;
}

// --------------------------------------------------------------------- roles

function roleRow(role) {
  const el = tplRole.content.firstElementChild.cloneNode(true);
  const btn = el.querySelector(".role-btn");
  const box = el.querySelector(".role-body");
  const state = el.querySelector(".role-state");

  el.querySelector(".role-name").textContent = role.roleName;
  btn.title = role.roleArn;

  const held = creds[role.roleArn];
  state.textContent = isLive(held) ? "issued" : "get credentials";
  if (isLive(held)) state.classList.add("issued");

  const collapse = () => {
    box.hidden = true;
    box.textContent = "";
    btn.setAttribute("aria-expanded", "false");
    shown.delete(role.roleArn);
  };

  const expand = async () => {
    btn.setAttribute("aria-expanded", "true");
    box.hidden = false;
    shown.add(role.roleArn);

    let held = creds[role.roleArn];

    if (!isLive(held)) {
      box.textContent = "";
      box.append(note("Requesting credentials from STS…"));

      const res = await chrome.runtime.sendMessage({
        type: "mint",
        roleArn: role.roleArn,
      });

      box.textContent = "";

      if (!res?.ok) {
        box.append(failure(role.roleName, res?.error ?? "Minting failed"));
        if (res?.stale) renderBanner();
        return;
      }
      creds[role.roleArn] = res;
      held = res;
      state.textContent = "issued";
      state.classList.add("issued");
    }

    box.textContent = "";
    box.append(credentials(held));
    tick();
  };

  btn.addEventListener("click", () => (box.hidden ? expand() : collapse()));

  if (shown.has(role.roleArn) && isLive(creds[role.roleArn])) {
    btn.setAttribute("aria-expanded", "true");
    box.hidden = false;
    box.append(credentials(creds[role.roleArn]));
  }

  return el;
}

// --------------------------------------------------------------- credentials

function credentials(c) {
  const el = tplCreds.content.firstElementChild.cloneNode(true);
  el.dataset.expiration = c.expiration || "";
  el.dataset.minted = c.mintedAt || Date.now();

  for (const code of el.querySelectorAll("code[data-k]")) {
    const value = c[code.dataset.k] || "";
    code.dataset.value = value;
    code.textContent =
      code.dataset.masked === "true"
        ? "•".repeat(28)
        : code.classList.contains("tok")
        ? `${value.slice(0, 24)}… (${value.length} chars)`
        : value;
  }

  const revealBtn = el.querySelector(".reveal");
  revealBtn.addEventListener("click", () => {
    const code = el.querySelector("code[data-masked]");
    const hidden = code.dataset.masked === "true";
    code.dataset.masked = hidden ? "false" : "true";
    code.textContent = hidden ? code.dataset.value : "•".repeat(28);
    revealBtn.textContent = hidden ? "Hide" : "Show";
  });

  for (const btn of el.querySelectorAll("[data-copy]")) {
    btn.addEventListener("click", () => copy(btn.dataset.copy, c));
  }

  el.querySelector(".switch").addEventListener("click", () => {
    form.source = c.roleArn;
    saveForm();
    view = "clients";
    render();
  });

  return el;
}

// ------------------------------------------------------------------- pieces

function empty() {
  const el = document.createElement("div");
  el.className = "empty";
  el.innerHTML = `
    <p><strong>Sign in to the AWS console</strong> through Keycloak. Every account
    and role in your assertion is listed here afterwards.</p>
    <p>Credentials are issued only for the role you click, and are held in memory
    only until you close Chrome.</p>`;
  return el;
}

function failure(label, why) {
  const el = document.createElement("div");
  el.className = "failure";
  const head = document.createElement("p");
  head.textContent = `${label} could not be exchanged for credentials.`;
  const reason = document.createElement("p");
  reason.className = "why";
  reason.textContent = why;
  el.append(head, reason);
  return el;
}

function note(text) {
  const el = document.createElement("p");
  el.className = "note";
  el.textContent = text;
  return el;
}

// ---------------------------------------------------------------- countdown

function tick() {
  const now = Date.now();
  for (const el of document.querySelectorAll(".creds")) {
    const expires = Date.parse(el.dataset.expiration);
    const remainingEl = el.querySelector(".remaining");
    const fill = el.querySelector(".fill");

    if (!Number.isFinite(expires)) {
      remainingEl.textContent = "unknown";
      fill.style.width = "100%";
      continue;
    }

    const left = expires - now;
    if (left <= 0) {
      el.classList.add("expired", "stale");
      remainingEl.textContent = "expired";
      fill.style.width = "100%";
      continue;
    }

    // The bar spans the whole granted session, not an arbitrary hour.
    const granted = Math.max(expires - Number(el.dataset.minted), 60e3);
    remainingEl.textContent = `${duration(left)} left`;
    fill.style.width = `${Math.min(100, (left / granted) * 100)}%`;
  }
}

function duration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

function timeOfDay(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function count(n, noun) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function isLive(c) {
  if (!c?.ok) return false;
  const at = Date.parse(c.expiration ?? "");
  return !Number.isFinite(at) || at > Date.now();
}

// ----------------------------------------------------------- client profiles

/**
 * Each value ends up inside an INI file the user pastes by hand, so these are
 * strict on purpose: a newline or "[" in any field could inject extra settings.
 */
const RULES = {
  name: /^[A-Za-z0-9_.-]{1,64}$/,
  accountId: /^\d{12}$/,
  roleName: /^[\w+=,.@-]+(\/[\w+=,.@-]+)*$/, // allows a path, e.g. team/DevOps
  region: /^[a-z]{2}(-gov|-iso[a-z]?)?-[a-z]+-\d$/,
};

const blankRow = () => ({ name: "", accountId: "", roleName: "", region: "" });

/** The client rows for the jump role currently open in the switch-role view. */
function currentRows() {
  return (form.lists[form.source] ??= []);
}

function saveForm() {
  chrome.storage.session.set({ [K_FORM]: form });
}

function clientsView(src) {
  const el = tplClients.content.firstElementChild.cloneNode(true);

  el.querySelector(".back").addEventListener("click", () => {
    view = "roles";
    render();
  });
  el.querySelector(".src-name").textContent = sourceProfileName(src);
  el.querySelector(".src-session").textContent = sessionName(src) ?? "unknown";

  const rowsEl = el.querySelector("#crows");
  const rows = currentRows();
  if (!rows.length) rows.push(blankRow());
  for (const r of rows) rowsEl.append(clientRow(r));

  el.querySelector("#add-row").addEventListener("click", () => {
    const r = blankRow();
    currentRows().push(r);
    const rowEl = clientRow(r);
    rowsEl.append(rowEl);
    rowEl.querySelector("input").focus();
    changed();
  });

  el.querySelector("#copy-config").addEventListener("click", copyConfig);
  return el;
}

function clientRow(r) {
  const el = tplClientRow.content.firstElementChild.cloneNode(true);
  el._row = r;
  for (const input of el.querySelectorAll("input[data-f]")) {
    input.value = r[input.dataset.f] ?? "";
    input.addEventListener("input", () => {
      r[input.dataset.f] = input.value;
      changed();
    });
  }
  el.querySelector(".remove").addEventListener("click", () => {
    const rows = currentRows();
    rows.splice(rows.indexOf(r), 1);
    el.remove();
    changed();
  });
  return el;
}

function changed() {
  saveForm();
  refreshPreview();
}

function sourceRole() {
  return session?.roles?.find((r) => r.roleArn === form.source) ?? null;
}

/** Same name "Copy profile block" writes, so the two files line up. */
function sourceProfileName(src) {
  return `${src.accountId}-${src.roleName}`;
}

/**
 * The user's own session name (their email or username, as Keycloak set it),
 * read from the jump role's issued credentials:
 *   arn:aws:sts::123456789012:assumed-role/JumpRole/<session name>
 * Reused as role_session_name so the client account's CloudTrail shows who
 * switched in. Returns null if it can't be read or isn't a valid session name.
 */
function sessionName(src) {
  const arn = creds[src.roleArn]?.assumedRoleArn ?? "";
  const m = arn.match(/:assumed-role\/[^/]+\/(.+)$/);
  return m && /^[\w+=,.@-]{2,64}$/.test(m[1]) ? m[1] : null;
}

/**
 * Profile names this list must not reuse: every name entered under another
 * jump role (both blocks end up in the same ~/.aws/config, where a repeated
 * name silently overrides), and every jump role's own credentials profile name.
 */
function reservedNames() {
  const names = new Set((session?.roles ?? []).map(sourceProfileName));
  for (const [source, rows] of Object.entries(form.lists)) {
    if (source === form.source) continue;
    for (const r of rows) {
      const name = (r.name ?? "").trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** Field names that are wrong in a row ("name" also covers duplicates). */
function rowProblems(r, takenNames) {
  const bad = [];
  for (const [k, re] of Object.entries(RULES)) {
    if (!re.test((r[k] ?? "").trim())) bad.push(k);
  }
  const name = (r.name ?? "").trim();
  if (name && takenNames.has(name)) bad.push("dup");
  return bad;
}

/** What to tell the user when a typed field is wrong. */
const HINTS = {
  name: "Profile name can only use letters, numbers, - _ and .",
  accountId: "Account ID must be exactly 12 digits.",
  roleName: "Role name has characters IAM doesn't allow.",
  region: "Region should look like ap-south-1.",
};

function trimmed(row) {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, (v ?? "").trim()]));
}

function configBlock() {
  const src = sourceRole();
  const who = src && sessionName(src);
  if (!who) return "";
  const partition = src.roleArn.split(":")[1]; // aws, aws-cn, aws-us-gov
  const srcName = sourceProfileName(src);
  const taken = reservedNames();
  const out = [];

  for (const r of currentRows().map(trimmed)) {
    if (rowProblems(r, taken).length) continue;
    taken.add(r.name);
    out.push(
      `[profile ${r.name}]`,
      `role_arn = arn:${partition}:iam::${r.accountId}:role/${r.roleName}`,
      `source_profile = ${srcName}`,
      `role_session_name = ${who}`,
      `region = ${r.region}`,
      ""
    );
  }
  return out.join("\n");
}

function refreshPreview() {
  const preview = document.getElementById("preview");
  if (!preview) return;

  // Highlight bad fields, but leave empty required ones alone until something is typed.
  const src = sourceRole();
  const taken = reservedNames();
  for (const rowEl of document.querySelectorAll(".crow")) {
    const r = trimmed(rowEl._row);
    const bad = new Set(rowProblems(r, taken));
    if (!bad.size) taken.add(r.name);

    const msgs = [];
    for (const input of rowEl.querySelectorAll("input[data-f]")) {
      const k = input.dataset.f;
      if (input.value.trim() === "") {
        input.classList.remove("bad");
        continue;
      }
      const dup = k === "name" && bad.has("dup") && !bad.has("name");
      const wrong = bad.has(k) || dup;
      input.classList.toggle("bad", wrong);
      if (dup) {
        msgs.push(`Profile name "${r.name}" is already used. Names must be unique across all jump roles.`);
      } else if (wrong) {
        msgs.push(HINTS[k]);
      }
    }
    const err = rowEl.querySelector(".crow-err");
    err.textContent = msgs.join(" ");
    err.hidden = !msgs.length;
  }

  const text = configBlock();
  preview.textContent =
    text ||
    (src && !sessionName(src)
      ? "Could not read your session name from this role's credentials. Clear, sign in again, and reissue them."
      : "Fill in a client row to see the config block.");
  preview.classList.toggle("empty-preview", !text);
}

async function copyConfig() {
  const text = configBlock();
  if (!text) {
    toast("Nothing valid to copy yet");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("Config block copied");
  } catch {
    toast("Clipboard blocked by Chrome");
  }
}

// -------------------------------------------------------------------- copy

async function copy(what, c) {
  let text;
  let label;

  if (what === "env") {
    text =
      `export AWS_ACCESS_KEY_ID=${c.accessKeyId}\n` +
      `export AWS_SECRET_ACCESS_KEY=${c.secretAccessKey}\n` +
      `export AWS_SESSION_TOKEN=${c.sessionToken}\n`;
    label = "Shell exports copied";
  } else if (what === "profile") {
    text =
      `[${c.accountId}-${c.roleName}]\n` +
      `aws_access_key_id = ${c.accessKeyId}\n` +
      `aws_secret_access_key = ${c.secretAccessKey}\n` +
      `aws_session_token = ${c.sessionToken}\n`;
    label = "Profile block copied";
  } else {
    text = c[what];
    label = "Copied";
  }

  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    toast("Clipboard blocked by Chrome");
  }
}

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("on"), 1400);
}
