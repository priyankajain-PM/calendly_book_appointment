// server.js
// Node 18+ (ESM). package.json should include: { "type": "module" }
import 'dotenv/config';
import fs from "fs";
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3001;
const API = "https://api.calendly.com";

// ---- Basic middleware
app.use(cors());            // allow browser UI from another origin
app.use(express.json());    // parse JSON POST bodies
app.use(express.static("public")); // optional: serve your front-end from ./public

function addMinutesISO(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60 * 1000).toISOString();
}
function normalizeISO(s) { return new Date(s).toISOString(); }

// ---- Load hosts (public scheduling_url in event_type_uri field)
const hosts = JSON.parse(fs.readFileSync("./hosts.json", "utf-8"));

// ---- Tiny Calendly helper
async function calendly(token, path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Calendly ${path} -> ${res.status} ${body}`);
  }
  return res.json();
}

// ---- Cache: host_id -> API event type URI (https://api.calendly.com/event_types/<UUID>)
const EVENT_TYPE_URI_CACHE = new Map();

/**
 * Resolve a host's public scheduling_url (from hosts.json) to its API Event Type URI.
 * Uses that host's PAT to: GET /users/me -> GET /event_types?user=... and match by scheduling_url.
 */
async function resolveEventTypeApiUriForHost(host) {
  if (EVENT_TYPE_URI_CACHE.has(host.host_id)) return EVENT_TYPE_URI_CACHE.get(host.host_id);

  const token = process.env[host.pat_env];
  if (!token) throw new Error(`Missing PAT env var for ${host.host_id}: ${host.pat_env}`);

  // Who am I?
  const me = await calendly(token, "/users/me");
  const userUri = me?.resource?.uri;
  if (!userUri) throw new Error(`users/me returned no resource.uri for ${host.host_id}`);

  // List event types for this user
  const list = await calendly(token, `/event_types?user=${encodeURIComponent(userUri)}`);
  const match = (list.collection || []).find(et => et.scheduling_url === host.event_type_uri);
  if (!match) {
    const available = (list.collection || []).map(e => e.scheduling_url).join(", ");
    throw new Error(
      `No event_type with scheduling_url=${host.event_type_uri} for ${host.host_id}. Seen: [${available}]`
    );
  }

  EVENT_TYPE_URI_CACHE.set(host.host_id, match.uri); // API URI
  return match.uri;
}

/**
 * Check if the exact start/end slot is available for a host's event type.
 * Returns true/false (Calendly available-times endpoint is limited to a 7-day window).
 */
function toISO(isoish) {
  // Force a canonical ISO string with milliseconds, e.g. 2025-11-07T10:00:00.000Z
  return new Date(isoish).toISOString();
}

function sameInstant(a, b) {
  return new Date(a).getTime() === new Date(b).getTime();
}



async function hostHasExactSlot(host, start_time, end_time) {
  const token = process.env[host.pat_env];
  const et = await resolveEventTypeApiUriForHost(host);

  // Normalize what we send to Calendly
  const startISO = toISO(start_time);
  const endISO   = toISO(end_time);

  const q = new URLSearchParams({
    event_type: et,
    start_time: startISO,
    end_time:   endISO,
    timezone: "UTC",
  });

  try {
    const j = await calendly(token, `/event_type_available_times?${q.toString()}`);
    return (j.collection || []).some(s =>
      sameInstant(s.start_time, startISO) && sameInstant(s.end_time, endISO)
    );
  } catch (e) {
    return false;
  }
}

/**
 * Merge union of open slots across all hosts for a given window.
 * Returns [{ start_time, end_time, hosts:[{id,name},...] }, ...]
 */



async function getUnionSlots({ start, end, timezone }) {
  const results = await Promise.allSettled(
    hosts.map(async (h) => {
      const token = process.env[h.pat_env];
      if (!token) throw new Error(`Missing PAT env var for ${h.host_id}: ${h.pat_env}`);
      const et = await resolveEventTypeApiUriForHost(h);
      const q = new URLSearchParams({
        event_type: et,
        start_time: start,
        end_time: end,
        timezone: timezone || "UTC",
      });
      const data = await calendly(token, `/event_type_available_times?${q.toString()}`);
      const durationMinutes = 30; 
      const slots = (data.collection || []).map(s => ({
        start_time: s.start_time,
        end_time: addMinutesISO(s.start_time, durationMinutes),
        host_id: h.host_id,
        host_name: h.display_name,
      }));
      return { host: h, slots };
    })
  );

  // Union by exact start/end
  const bucket = new Map();
  for (const r of results) {
    if (r.status !== "fulfilled") {
      console.warn("Availability fetch failed:", r.reason?.message || r.reason);
      continue;
    }
    for (const s of r.value.slots) {
      const key = `${s.start_time}__${s.end_time}`;
      const entry = bucket.get(key) || { start_time: s.start_time, end_time: s.end_time, hosts: [] };
      entry.hosts.push({ id: s.host_id, name: s.host_name });
      bucket.set(key, entry);
    }
  }
  return [...bucket.values()].sort((a,b) => a.start_time.localeCompare(b.start_time));
}

// ------------------- ROUTES -------------------

app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * GET /api/slots?start=ISO&end=ISO&timezone=Asia/Kolkata
 * Returns union of available slots across all hosts for the window (<= 7 days recommended).
 */
/*app.get("/api/slots", async (req, res) => {
  try {
    const { start, end, timezone = "Asia/Kolkata" } = req.query;
    if (!start || !end) return res.status(400).json({ error: "start and end are required ISO strings" });
    const slots = await getUnionSlots({ start, end, timezone });
    res.json({ slots });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
*/

app.get("/api/slots", async (req, res) => {
  try {
    let { start, end, timezone } = req.query;

    // ---- Normalize timezone ----
    if (!timezone || timezone.toLowerCase() === "asia/calcutta") {
      timezone = "Asia/Kolkata";
    }

    // ---- Parse & clamp times ----
    const now = new Date();                         // server’s current time
    const minStart = new Date(now.getTime() + 60_000); // now + 1 min to avoid “must be in the future”
    const startDate = new Date(start);
    const endDate = new Date(end);

    if (isNaN(startDate) || isNaN(endDate)) {
      return res.status(400).json({ error: "Invalid start or end (must be ISO 8601)" });
    }

    // Calendly requires start in the future
    const clampedStart = startDate < minStart ? minStart : startDate;

    // Enforce Calendly’s ~7-day window
    const maxEnd = new Date(clampedStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    const clampedEnd = endDate > maxEnd ? maxEnd : endDate;

    if (clampedEnd <= clampedStart) {
      return res.status(400).json({ error: "End must be after start and within 7 days" });
    }

    // Format back to ISO without milliseconds (Calendly accepts full ISO; trimming helps diff noise)
    const startISO = clampedStart.toISOString();
    const endISO = clampedEnd.toISOString();

    const slots = await getUnionSlots({ start: startISO, end: endISO, timezone });
    res.json({ slots, meta: { start: startISO, end: endISO, timezone } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/book
 * Body: { start_time, end_time, invitee: { name, email } }
 * Picks eligible hosts for that exact slot and assigns by highest priority_weight.
 * Attempts Scheduling API booking; falls back to single-use link if not allowed.
 */
app.post("/api/book", async (req, res) => {
  try {
    const { start_time, end_time, invitee } = req.body || {};
    if (!start_time || !end_time || !invitee?.email || !invitee?.name) {
      return res.status(400).json({ error: "start_time, end_time, invitee{name,email} are required" });
    }

    // normalize once
    const startISO = toISO(start_time);
    const endISO   = toISO(end_time);

    // Determine eligible hosts (who truly have the exact slot)
    const eligible = [];
    for (const h of hosts) {
      if (await hostHasExactSlot(h, startISO, endISO)) {
        const et = await resolveEventTypeApiUriForHost(h);
        eligible.push({ ...h, et });
      }
    }
    if (!eligible.length) return res.status(409).json({ error: "Slot no longer available" });

    eligible.sort((a, b) => b.priority_weight - a.priority_weight);
    const chosen = eligible[0];
    const token = process.env[chosen.pat_env];

    // Try Scheduling API with normalized times
    const r = await fetch(`${API}/event_invitees`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: chosen.et,
        start_time: startISO,
        end_time:   endISO,
        invitee: { name: invitee.name, email: invitee.email },
      }),
    });

    if (r.ok) {
      const booking = await r.json();
      return res.json({ booking, host_assigned: chosen.display_name });
    }

    if ([403, 404, 422].includes(r.status)) {
      const linkRes = await fetch(`${API}/scheduling_links`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: chosen.et,
          owner_type: "EventType",
          max_event_count: 1
        }),
      });
      if (!linkRes.ok) {
        return res.status(502).json({ error: `Fallback link failed: ${linkRes.status} ${await linkRes.text()}` });
      }
      const link = await linkRes.json();
      return res.json({ redirect: link?.resource?.booking_url, host_assigned: chosen.display_name });
    }

    return res.status(502).json({ error: `Scheduling API failed: ${r.status} ${await r.text()}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ---------------------------------------------
app.listen(PORT, () => console.log(`API on :${PORT}`));
