/**
 * AWS STS Keys (Keycloak SSO)
 *
 * Flow:
 *   1. User signs in to the AWS console through Keycloak as normal.
 *   2. The browser POSTs a SAMLResponse to https://signin.aws.amazon.com/saml.
 *   3. We observe that POST, pull the roles out of the assertion, and call
 *      sts:AssumeRoleWithSAML for each one.
 *   4. Credentials go into chrome.storage.session (memory only) for the popup.
 *
 * The assertion is short-lived (usually ~5 min), so the exchange has to happen
 * here at sign-in time, not later when the popup opens. That is why all roles in
 * the assertion are minted rather than only the one the user clicks in the AWS
 * role chooser -- at this point in the flow that choice hasn't been made yet.
 *
 * AssumeRoleWithSAML takes unsigned requests, so there is no SigV4 and no
 * embedded credential of any kind in this extension.
 */

const STS_ENDPOINT = "https://sts.amazonaws.com/";
const STS_API_VERSION = "2011-06-15";
const SIGNIN_URL = "https://signin.aws.amazon.com/saml";
const MAX_ROLES = 8;

// ---------------------------------------------------------------- interception

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.method !== "POST") return;
    const raw = details.requestBody?.formData?.SAMLResponse?.[0];
    if (!raw) return;
    // Fire and forget: this listener is non-blocking and must not delay sign-in.
    handleAssertion(raw).catch((err) => console.error("[sts] failed:", err));
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

  const pairs = extractRolePairs(xml);
  if (!pairs.length) {
    await setState({
      error:
        "No AWS role attribute found in the assertion. Check the Role attribute mapper on the Keycloak SAML client.",
      capturedAt: Date.now(),
      sessions: [],
    });
    return;
  }

  const requested = extractSessionDuration(xml);
  const results = await Promise.all(
    pairs.slice(0, MAX_ROLES).map((p) => assumeRole(p, assertionB64, requested))
  );

  await setState({
    error: null,
    capturedAt: Date.now(),
    sessions: results.sort((a, b) => a.roleName.localeCompare(b.roleName)),
  });

  const ok = results.filter((r) => r.ok).length;
  await setBadge(ok);
}

// ------------------------------------------------------------ assertion parsing

/** Pulls {roleArn, principalArn} out of the AWS Role SAML attribute. */
function extractRolePairs(xml) {
  const arn = String.raw`arn:aws[a-z\-]*:iam::\d{12}:(?:role|saml-provider)\/[^<,\s]+`;
  const re = new RegExp(`(${arn})\\s*,\\s*(${arn})`, "g");
  const seen = new Set();
  const pairs = [];

  for (const m of xml.matchAll(re)) {
    // AWS permits either order in the attribute value.
    const [roleArn, principalArn] = m[1].includes(":role/")
      ? [m[1], m[2]]
      : [m[2], m[1]];
    if (!roleArn.includes(":role/") || !principalArn.includes(":saml-provider/")) continue;
    if (seen.has(roleArn)) continue;
    seen.add(roleArn);
    pairs.push({ roleArn, principalArn });
  }
  return pairs;
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

async function assumeRole({ roleArn, principalArn }, assertionB64, requested) {
  const meta = {
    roleArn,
    principalArn,
    accountId: roleArn.split(":")[4],
    roleName: roleArn.split(":role/")[1],
  };

  const body = new URLSearchParams({
    Action: "AssumeRoleWithSAML",
    Version: STS_API_VERSION,
    RoleArn: roleArn,
    PrincipalArn: principalArn,
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
      return { ...meta, ok: false, error: stsError(text) || `HTTP ${res.status}` };
    }
  } catch (e) {
    return { ...meta, ok: false, error: `Could not reach STS: ${e.message}` };
  }

  const accessKeyId = tag(text, "AccessKeyId");
  const secretAccessKey = tag(text, "SecretAccessKey");
  const sessionToken = tag(text, "SessionToken");
  if (!accessKeyId || !secretAccessKey || !sessionToken) {
    return { ...meta, ok: false, error: stsError(text) || "Unexpected STS response" };
  }

  return {
    ...meta,
    ok: true,
    error: null,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    expiration: tag(text, "Expiration"),
    assumedRoleArn: tag(text, "Arn"),
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

async function setState(state) {
  await chrome.storage.session.set({ state });
}

async function setBadge(count) {
  await chrome.action.setBadgeBackgroundColor({ color: "#8A6A3A" });
  await chrome.action.setBadgeTextColor?.({ color: "#F2EDE4" });
  await chrome.action.setBadgeText({ text: count ? String(count) : "" });
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === "clear") {
    chrome.storage.session.remove("state").then(() => {
      setBadge(0);
      respond({ ok: true });
    });
    return true;
  }
});
