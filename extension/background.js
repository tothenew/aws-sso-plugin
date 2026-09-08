/**
 * AWS STS Keys (Keycloak SSO)
 *
 * Flow:
 *   1. User signs in to the AWS console through Keycloak as normal.
 *   2. The browser POSTs a SAMLResponse to https://signin.aws.amazon.com/saml.
 *   3. We observe that POST and store the assertion plus the list of roles it
 *      carries. Nothing is minted yet.
 *   4. When the user clicks a role in the popup, we exchange the assertion for
 *      credentials for that one role via sts:AssumeRoleWithSAML.
 *
 * Why minting is deferred (this reverses the original design):
 *   With ~50 accounts, minting everything at sign-in meant 50 STS calls per
 *   sign-in, 50 sets of live credentials sitting in memory that nobody asked
 *   for, and 50 CloudTrail events that correspond to no actual use. Minting on
 *   demand means one call per role a user actually wants, and the only broad
 *   secret held is the assertion itself.
 *
 * The cost of deferring:
 *   The assertion is short-lived - Keycloak typically sets NotOnOrAfter about
 *   five minutes out, and AWS enforces it. Past that, minting fails until the
 *   user signs in to the AWS console again, which re-POSTs a fresh assertion
 *   that this listener picks up. Because the Keycloak session is still alive,
 *   that is a redirect rather than a login.
 *
 * AWS does not do replay detection on SAML assertions, so one assertion can be
 * exchanged repeatedly inside its validity window. That is what makes on-demand
 * minting possible at all.
 *
 * AssumeRoleWithSAML takes unsigned requests, so there is no SigV4 and no
 * embedded credential of any kind in this extension.
 */

const STS_ENDPOINT = "https://sts.amazonaws.com/";
const STS_API_VERSION = "2011-06-15";
const SIGNIN_URL = "https://signin.aws.amazon.com/saml";

// There is deliberately no cap on the number of roles. Every role the assertion
// carries is listed, however many accounts that turns out to be. The old cap of
// 8 existed because every role was minted at sign-in and that cost an STS call
// each; now that minting happens on click, a long list costs nothing but rows
// in the popup. The assertion is signed by the IdP and enforced by AWS, so its
// contents are the authority on what the user has access to.

// Both live in chrome.storage.session: memory only, cleared when the browser
// closes, and by default readable only from extension pages (TRUSTED_CONTEXTS),
// never from a content script or a web page.
const K_SESSION = "session"; // assertion + the roles it grants
const K_CREDS = "creds";     // roleArn -> minted credentials

// ---------------------------------------------------------------- interception

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.method !== "POST") return;
    const raw = details.requestBody?.formData?.SAMLResponse?.[0];
    if (!raw) return;
    // Fire and forget: this listener is non-blocking and must not delay sign-in.
    handleAssertion(raw).catch((err) => console.error("[sts] capture failed:", err));
  },
  { urls: [SIGNIN_URL] },
  ["requestBody"]
);

async function handleAssertion(assertionB64) {
  let xml;
  try {
    xml = atob(assertionB64);
  } catch {
    throw new Error("SAMLResponse was not valid base64");
  }

  const roles = extractRolePairs(xml);

  if (!roles.length) {
    await write(K_SESSION, {
      capturedAt: Date.now(),
      assertion: null,
      assertionExpiresAt: null,
      requestedDuration: null,
      roles: [],
      error:
        "No AWS role attribute found in the assertion. Check the Role attribute mapper on the Keycloak SAML client.",
    });
    await setBadge(0);
    return;
  }

  await write(K_SESSION, {
    capturedAt: Date.now(),
    assertion: assertionB64,
    assertionExpiresAt: extractAssertionExpiry(xml),
    requestedDuration: extractSessionDuration(xml),
    roles: roles.sort(
      (a, b) => a.accountId.localeCompare(b.accountId) || a.roleName.localeCompare(b.roleName)
    ),
    error: null,
  });

  // Credentials already minted stay put. A user who signs in again only to
  // refresh the assertion should not lose sessions that are still good.
  await prune();
  await setBadge(roles.length);
}

// ------------------------------------------------------------ assertion parsing

/** Pulls {roleArn, principalArn, accountId, roleName} out of the AWS Role attribute. */
function extractRolePairs(xml) {
  const arn = String.raw`arn:aws[a-z\-]*:iam::\d{12}:(?:role|saml-provider)\/[^<,\s]+`;
  const re = new RegExp(`(${arn})\\s*,\\s*(${arn})`, "g");
  const seen = new Set();
  const roles = [];

  for (const m of xml.matchAll(re)) {
    // AWS permits either order in the attribute value.
    const [roleArn, principalArn] = m[1].includes(":role/")
      ? [m[1], m[2]]
      : [m[2], m[1]];
    if (!roleArn.includes(":role/") || !principalArn.includes(":saml-provider/")) continue;
    if (seen.has(roleArn)) continue;
    seen.add(roleArn);
    roles.push({
      roleArn,
      principalArn,
      accountId: roleArn.split(":")[4],
      roleName: roleArn.split(":role/")[1],
    });
  }
  return roles;
}

/**
 * Earliest NotOnOrAfter in the assertion, as epoch ms.
 *
 * The assertion carries several of these (Conditions, SubjectConfirmationData).
 * Taking the minimum is the conservative read: once the earliest has passed,
 * AWS may reject the exchange, so the popup should stop offering to mint.
 */
function extractAssertionExpiry(xml) {
  const times = [];
  for (const m of xml.matchAll(/NotOnOrAfter="([^"]+)"/g)) {
    const t = Date.parse(m[1]);
    if (Number.isFinite(t)) times.push(t);
  }
  return times.length ? Math.min(...times) : null;
}

/** Reads the optional SessionDuration attribute, if the IdP sends one. */
function extractSessionDuration(xml) {
  const m = xml.match(
    /SessionDuration[\s\S]{0,200}?<(?:\w+:)?AttributeValue[^>]*>\s*(\d+)\s*</i
  );
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------------- STS call

async function assumeRole(role, assertionB64, requested) {
  const body = new URLSearchParams({
    Action: "AssumeRoleWithSAML",
    Version: STS_API_VERSION,
    RoleArn: role.roleArn,
    PrincipalArn: role.principalArn,
    SAMLAssertion: assertionB64,
  });
  // Only send DurationSeconds when the IdP asked for one. Otherwise let the
  // role's own MaxSessionDuration govern, so we can't overshoot it and fail.
  if (requested) body.set("DurationSeconds", String(requested));

  let text;
  try {
    const res = await fetch(STS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    text = await res.text();
    if (!res.ok) {
      return { ok: false, error: stsError(text) || `HTTP ${res.status}` };
    }
  } catch (e) {
    return { ok: false, error: `Could not reach STS: ${e.message}` };
  }

  const accessKeyId = tag(text, "AccessKeyId");
  const secretAccessKey = tag(text, "SecretAccessKey");
  const sessionToken = tag(text, "SessionToken");
  if (!accessKeyId || !secretAccessKey || !sessionToken) {
    return { ok: false, error: stsError(text) || "Unexpected STS response" };
  }

  return {
    ok: true,
    error: null,
    roleArn: role.roleArn,
    accountId: role.accountId,
    roleName: role.roleName,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    expiration: tag(text, "Expiration"),
    assumedRoleArn: tag(text, "Arn"),
    mintedAt: Date.now(),
  };
}

// No DOMParser in a service worker, so pull single-value tags directly.
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1].trim()) : null;
}

function stsError(xml) {
  const code = tag(xml, "Code");
  const msg = tag(xml, "Message");
  if (!code && !msg) return null;
  return [code, msg].filter(Boolean).join(": ");
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// -------------------------------------------------------------------- storage

async function read(key) {
  const bag = await chrome.storage.session.get(key);
  return bag[key] ?? null;
}

async function write(key, value) {
  await chrome.storage.session.set({ [key]: value });
}

/** Drops credentials that have already expired. Nothing else touches them. */
async function prune() {
  const creds = (await read(K_CREDS)) ?? {};
  const now = Date.now();
  let changed = false;

  for (const [arn, c] of Object.entries(creds)) {
    const at = Date.parse(c?.expiration ?? "");
    if (Number.isFinite(at) && at <= now) {
      delete creds[arn];
      changed = true;
    }
  }
  if (changed) await write(K_CREDS, creds);
  return creds;
}

async function setBadge(count) {
  await chrome.action.setBadgeBackgroundColor({ color: "#8A6A3A" });
  await chrome.action.setBadgeTextColor?.({ color: "#F2EDE4" });
  await chrome.action.setBadgeText({ text: count ? String(count) : "" });
}

// ------------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === "mint") {
    mint(msg.roleArn).then(respond);
    return true; // keep the channel open for the async reply
  }

  if (msg?.type === "clear") {
    chrome.storage.session
      .remove([K_SESSION, K_CREDS])
      .then(() => setBadge(0))
      .then(() => respond({ ok: true }));
    return true;
  }
});

/** Exchanges the stored assertion for credentials for exactly one role. */
async function mint(roleArn) {
  const session = await read(K_SESSION);

  if (!session?.assertion) {
    return { ok: false, error: "No sign-in captured. Sign in to the AWS console first." };
  }

  const role = session.roles.find((r) => r.roleArn === roleArn);
  if (!role) {
    return { ok: false, error: "That role is not in the captured assertion." };
  }

  if (session.assertionExpiresAt && Date.now() >= session.assertionExpiresAt) {
    return {
      ok: false,
      stale: true,
      error: "The sign-in has expired. Sign in to the AWS console again to mint new credentials.",
    };
  }

  const result = await assumeRole(role, session.assertion, session.requestedDuration);

  if (result.ok) {
    const creds = (await read(K_CREDS)) ?? {};
    creds[roleArn] = result;
    await write(K_CREDS, creds);
  }
  return result;
}
