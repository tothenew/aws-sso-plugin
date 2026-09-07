const body = document.getElementById("body");
const captured = document.getElementById("captured");
const clearBtn = document.getElementById("clear");
const toastEl = document.getElementById("toast");
const tpl = document.getElementById("tpl-session");

let ticker = null;

render();

clearBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clear" });
  render();
});

async function render() {
  clearInterval(ticker);
  body.textContent = "";

  const { state } = await chrome.storage.session.get("state");

  if (!state) {
    captured.textContent = "No session captured";
    clearBtn.hidden = true;
    body.append(empty());
    return;
  }

  captured.textContent = `Captured ${timeOfDay(state.capturedAt)}`;
  clearBtn.hidden = false;

  if (state.error) body.append(failure("Assertion", state.error));

  const usable = state.sessions.filter((s) => s.ok);
  const failed = state.sessions.filter((s) => !s.ok);

  if (!usable.length && !failed.length && !state.error) {
    body.append(empty());
    return;
  }

  for (const s of usable) body.append(card(s, state.capturedAt));
  for (const s of failed) body.append(failure(s.roleName, s.error));

  tick();
  ticker = setInterval(tick, 1000);
}

// ------------------------------------------------------------------- pieces

function card(s, capturedAt) {
  const el = tpl.content.firstElementChild.cloneNode(true);
  el.dataset.expiration = s.expiration || "";
  el.dataset.captured = capturedAt;

  el.querySelector(".role").textContent = s.roleName;
  el.querySelector(".role").title = s.assumedRoleArn || s.roleArn;
  el.querySelector(".account").textContent = s.accountId;

  for (const code of el.querySelectorAll("code[data-k]")) {
    const value = s[code.dataset.k] || "";
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
    const code = el.querySelector('code[data-masked]');
    const hidden = code.dataset.masked === "true";
    code.dataset.masked = hidden ? "false" : "true";
    code.textContent = hidden ? code.dataset.value : "•".repeat(28);
    revealBtn.textContent = hidden ? "Hide" : "Show";
  });

  for (const btn of el.querySelectorAll("[data-copy]")) {
    btn.addEventListener("click", () => copy(btn.dataset.copy, s));
  }

  return el;
}

function empty() {
  const el = document.createElement("div");
  el.className = "empty";
  el.innerHTML = `
    <p><strong>Sign in to the AWS console</strong> through Keycloak. Credentials
    for every role in your assertion appear here.</p>
    <p>They are held in memory only and disappear when you close Chrome.</p>`;
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

// ---------------------------------------------------------------- countdown

function tick() {
  const now = Date.now();
  for (const el of document.querySelectorAll(".card")) {
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
    const granted = Math.max(expires - Number(el.dataset.captured), 60e3);
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

// -------------------------------------------------------------------- copy

async function copy(what, s) {
  let text;
  let label;

  if (what === "env") {
    text =
      `export AWS_ACCESS_KEY_ID=${s.accessKeyId}\n` +
      `export AWS_SECRET_ACCESS_KEY=${s.secretAccessKey}\n` +
      `export AWS_SESSION_TOKEN=${s.sessionToken}\n`;
    label = "Shell exports copied";
  } else if (what === "profile") {
    text =
      `[${s.accountId}-${s.roleName}]\n` +
      `aws_access_key_id = ${s.accessKeyId}\n` +
      `aws_secret_access_key = ${s.secretAccessKey}\n` +
      `aws_session_token = ${s.sessionToken}\n`;
    label = "Profile block copied";
  } else {
    text = s[what];
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
