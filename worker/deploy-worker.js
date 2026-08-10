// Cloudflare Worker — Phase 0 self-service activity deployer
//
// SETUP (Cloudflare dashboard):
// 1. Workers & Pages → Create → Create Worker → paste this whole file, Deploy.
// 2. Worker → Settings → Variables → add secrets (click "Encrypt"):
//      GITHUB_TOKEN   = a GitHub PAT with `repo` scope on DuyRmit/acticities
//      DEPLOY_PASSCODE_HASH = f6c6046177bed371c31b6003317d6f26f2e04565c6b60e81dcb440943085f3b8
//    (that hash = sha256("RMIT-md-deploy-2026") — change the passcode by hashing a new
//     string yourself and swapping this value; keep the plaintext out of any code.)
// 3. Copy the Worker's *.workers.dev URL — paste it into WORKER_URL in upload/index.html.

const GITHUB_OWNER = "DuyRmit";
const GITHUB_REPO = "acticities";
const GITHUB_BRANCH = "main";
const PAGES_BASE = "https://duyrmit.github.io/acticities";

const FIREBASE_CONFIG_SNIPPET = `
      apiKey: "AIzaSyD-IEvx56ysu5GhKlOU-a-6jD7rUiY17nM",
      authDomain: "phase0-activity-analytics.firebaseapp.com",
      projectId: "phase0-activity-analytics",`;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function slugify(name) {
  return name
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function buildTrackerSnippet(activityId) {
  return `
  <!-- ==== Phase 0 auto-tracker (injected by deploy tool) ==== -->
  <script type="module">
    import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
    import { getFirestore, collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
    const firebaseConfig = {${FIREBASE_CONFIG_SNIPPET}
    };
    const ACTIVITY_ID = "${activityId}";
    const app = initializeApp(firebaseConfig);
    const db = getFirestore(app);

    function getAnonId() {
      let id = localStorage.getItem("phase0_anon_id");
      if (!id) { id = "anon-" + Math.random().toString(36).slice(2, 10); localStorage.setItem("phase0_anon_id", id); }
      return id;
    }
    const anonId = getAnonId();
    const sessionStart = Date.now();
    let interactionCount = 0;

    function sendEvent(eventType, extra) {
      addDoc(collection(db, "phase0_events"), {
        activity_id: ACTIVITY_ID, anon_id: anonId, event_type: eventType,
        client_timestamp: new Date().toISOString(), server_timestamp: serverTimestamp(),
        seconds_since_open: Math.round((Date.now() - sessionStart) / 1000), extra: extra || "",
      }).catch(() => {});
    }

    sendEvent("open");

    // Generic auto-tracking: explicit data-track wins, else id/name/text is used as the label.
    document.addEventListener("click", function (e) {
      const el = e.target.closest("button, a, [role='button'], input[type='submit']");
      if (!el) return;
      const label = el.getAttribute("data-track") || el.id || (el.textContent || "").trim().slice(0, 40) || el.tagName;
      interactionCount++;
      sendEvent("interaction", label);
    });
    document.addEventListener("change", function (e) {
      const el = e.target;
      if (!(el.tagName === "SELECT" || (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")))) return;
      const label = el.getAttribute("data-track") || el.id || el.name || el.tagName;
      interactionCount++;
      sendEvent("interaction", label + "=" + el.value);
    });

    window.addEventListener("beforeunload", function () {
      sendEvent("close", "total_interactions=" + interactionCount);
    });
  </script>
  `;
}

async function githubRequest(path, method, token, body) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`, {
    method,
    headers: {
      "Authorization": `token ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "phase0-deploy-worker",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders(origin) });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: corsHeaders(origin) });
    }

    const { passcode, activity_name, html } = payload;
    if (!passcode || !activity_name || !html) {
      return new Response(JSON.stringify({ error: "Missing passcode, activity_name, or html" }), { status: 400, headers: corsHeaders(origin) });
    }

    const hash = await sha256Hex(passcode);
    if (hash !== env.DEPLOY_PASSCODE_HASH) {
      return new Response(JSON.stringify({ error: "Incorrect passcode" }), { status: 401, headers: corsHeaders(origin) });
    }

    const slug = slugify(activity_name);
    if (!slug) {
      return new Response(JSON.stringify({ error: "Could not derive a valid slug from activity_name" }), { status: 400, headers: corsHeaders(origin) });
    }

    let finalHtml = html;
    if (!finalHtml.includes("phase0_events")) {
      const snippet = buildTrackerSnippet(slug);
      if (finalHtml.includes("</body>")) {
        finalHtml = finalHtml.replace("</body>", snippet + "\n</body>");
      } else {
        finalHtml += snippet;
      }
    }

    const path = `activities/${slug}/index.html`;

    // Check if file already exists (need its sha to update instead of create)
    let sha;
    const getRes = await githubRequest(path, "GET", env.GITHUB_TOKEN);
    if (getRes.status === 200) {
      const existing = await getRes.json();
      sha = existing.sha;
    }

    const putBody = {
      message: `Phase 0 deploy: ${activity_name} (via uploader)`,
      content: toBase64Utf8(finalHtml),
      branch: GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
    };

    const putRes = await githubRequest(path, "PUT", env.GITHUB_TOKEN, putBody);
    if (putRes.status !== 200 && putRes.status !== 201) {
      const errText = await putRes.text();
      return new Response(JSON.stringify({ error: "GitHub push failed", detail: errText }), { status: 502, headers: corsHeaders(origin) });
    }

    return new Response(JSON.stringify({
      ok: true,
      slug,
      live_url: `${PAGES_BASE}/activities/${slug}/`,
      dashboard_url: `${PAGES_BASE}/dashboard/`,
      updated: !!sha,
    }), { status: 200, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } });
  },
};
