/**
 * Cloudflare Worker: PCO Services -> Next 2 Sunday services
 * with songs, keys, and attachment download links
 *
 * Env vars (secrets):
 * - PCO_APP_ID
 * - PCO_SECRET
 * - PCO_SERVICE_TYPE_ID
 * Optional:
 * - CORS_ORIGIN (e.g. "https://yourchurch.subsplash.com")
 * - CACHE_TTL_SECONDS (defaults to 3600 = 1 hour)
 */

const PCO_API_BASE = "https://api.planningcenteronline.com";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function getCorsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allow = env.CORS_ORIGIN || "*";
  const allowOrigin =
    allow === "*" ? "*" : origin === allow ? origin : "null";
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
}

function isSundayInAmericaChicago(isoString) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
  }).format(new Date(isoString));
  return weekday === "Sun";
}

function dateKeyAmericaChicago(isoString) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(isoString));
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

function toLocalDisplayAmericaChicago(isoString) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(isoString));
}

function toTimeDisplayAmericaChicago(isoString) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(isoString));
}

function base64Basic(appId, secret) {
  return `Basic ${btoa(`${appId}:${secret}`)}`;
}

// ---------------------------------------------------------------------------
// PCO API fetchers
// ---------------------------------------------------------------------------

async function pcoGet(path, env) {
  const auth = base64Basic(env.PCO_APP_ID, env.PCO_SECRET);
  const resp = await fetch(`${PCO_API_BASE}${path}`, {
    headers: { Authorization: auth, Accept: "application/json" },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`PCO ${resp.status} ${path}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

/**
 * Fetch future plans (with plan_times included).
 */
async function fetchFuturePlans(env) {
  return pcoGet(
    `/services/v2/service_types/${env.PCO_SERVICE_TYPE_ID}/plans` +
      `?filter=future&order=sort_date&per_page=10&include=plan_times`,
    env
  );
}

/**
 * For a given plan, fetch its items including song + arrangement + attachments.
 * PCO supports: include=song,arrangement,attachment
 * We also include item_notes if you want them (omitted here for brevity).
 */
async function fetchPlanItems(planId, env) {
  return pcoGet(
    `/services/v2/service_types/${env.PCO_SERVICE_TYPE_ID}/plans/${planId}/items` +
      `?include=song,arrangement&per_page=100`,
    env
  );
}

/**
 * Fetch attachments for a specific arrangement.
 * Returns array of attachment objects.
 */
async function fetchArrangementAttachments(songId, arrangementId, env) {
  try {
    const data = await pcoGet(
      `/services/v2/songs/${songId}/arrangements/${arrangementId}/attachments?per_page=50`,
      env
    );
    return data?.data || [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Data extraction
// ---------------------------------------------------------------------------

function extractUpcomingSundayPlanIds(pcoPayload) {
  const now = Date.now();
  const plans = pcoPayload?.data || [];
  const included = pcoPayload?.included || [];

  // Build map: planId -> earliest future Sunday plan_time starts_at
  const planEarliestSunday = new Map();

  for (const inc of included) {
    if (inc.type !== "PlanTime") continue;
    const startsAt = inc?.attributes?.starts_at;
    const planId = inc?.relationships?.plan?.data?.id;
    if (!startsAt || !planId) continue;
    const ts = Date.parse(startsAt);
    if (!Number.isFinite(ts) || ts < now) continue;
    if (!isSundayInAmericaChicago(startsAt)) continue;

    const existing = planEarliestSunday.get(planId);
    if (!existing || ts < Date.parse(existing.starts_at)) {
      planEarliestSunday.set(planId, {
        starts_at: startsAt,
        sunday_date_local: dateKeyAmericaChicago(startsAt),
        date_display: toLocalDisplayAmericaChicago(startsAt),
      });
    }
  }

  // Also capture ALL plan_times for a plan (for service times listing)
  const planAllTimes = new Map();
  for (const inc of included) {
    if (inc.type !== "PlanTime") continue;
    const startsAt = inc?.attributes?.starts_at;
    const planId = inc?.relationships?.plan?.data?.id;
    if (!startsAt || !planId) continue;
    const ts = Date.parse(startsAt);
    if (!Number.isFinite(ts) || ts < now) continue;
    if (!isSundayInAmericaChicago(startsAt)) continue;

    if (!planAllTimes.has(planId)) planAllTimes.set(planId, []);
    planAllTimes.get(planId).push({
      starts_at: startsAt,
      time_display: toTimeDisplayAmericaChicago(startsAt),
      name: inc?.attributes?.name || "",
      plan_time_id: inc.id,
    });
  }

  // Sort by starts_at and keep only the next 2 distinct Sunday dates
  const entries = [...planEarliestSunday.entries()].sort(
    (a, b) => Date.parse(a[1].starts_at) - Date.parse(b[1].starts_at)
  );

  const seenDates = new Set();
  const result = [];
  for (const [planId, info] of entries) {
    if (!seenDates.has(info.sunday_date_local)) {
      if (seenDates.size >= 2) break;
      seenDates.add(info.sunday_date_local);
    }
    const plan = plans.find((p) => p.id === planId);
    const times = (planAllTimes.get(planId) || []).sort(
      (a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at)
    );
    result.push({
      plan_id: planId,
      plan_title: plan?.attributes?.title || "",
      plan_url: `https://services.planningcenteronline.com/plans/${planId}`,
      sunday_date_local: info.sunday_date_local,
      date_display: info.date_display,
      service_times: times,
    });
  }

  return result;
}

/**
 * Extract songs from a plan's items response, with arrangement key and links.
 */
function extractSongsFromItems(itemsPayload, songId_filter = null) {
  const items = itemsPayload?.data || [];
  const included = itemsPayload?.included || [];

  // Build lookup maps from included
  const songsById = new Map();
  const arrangementsById = new Map();

  for (const inc of included) {
    if (inc.type === "Song") songsById.set(inc.id, inc);
    if (inc.type === "Arrangement") arrangementsById.set(inc.id, inc);
  }

  const songs = [];

  for (const item of items) {
    if (item?.attributes?.item_type !== "song") continue;

    const songRel = item?.relationships?.song?.data;
    const arrangementRel = item?.relationships?.arrangement?.data;
    if (!songRel) continue;

    const song = songsById.get(songRel.id);
    const arrangement = arrangementRel
      ? arrangementsById.get(arrangementRel.id)
      : null;

    const songTitle =
      song?.attributes?.title ||
      item?.attributes?.title ||
      "Untitled Song";
    const songAuthor = song?.attributes?.author || "";
    const key = item?.attributes?.key_name || "";
    const itemSequence = item?.attributes?.sequence ?? 9999;

    songs.push({
      item_id: item.id,
      song_id: songRel.id,
      arrangement_id: arrangementRel?.id || null,
      title: songTitle,
      author: songAuthor,
      key,
      sequence: itemSequence,
      song_url: song
        ? `https://services.planningcenteronline.com/songs/${songRel.id}`
        : null,
      arrangement_url:
        songRel.id && arrangementRel?.id
          ? `https://services.planningcenteronline.com/songs/${songRel.id}/arrangements/${arrangementRel.id}`
          : null,
      // attachments will be filled in later
      attachments: [],
    });
  }

  songs.sort((a, b) => a.sequence - b.sequence);
  return songs;
}

/**
 * Classify an attachment into one of our categories.
 */
function classifyAttachment(att) {
  const name = (att?.attributes?.filename || att?.attributes?.description || "").toLowerCase();
  const fileType = (att?.attributes?.file_type || "").toLowerCase();
  const pcoType = (att?.attributes?.pco_type || "").toLowerCase();

  if (pcoType === "chord_chart" || name.includes("chord")) return "chord_chart";
  if (pcoType === "lead_sheet" || name.includes("lead sheet") || name.includes("leadsheet")) return "lead_sheet";
  if (
    fileType === "mp3" ||
    name.endsWith(".mp3") ||
    pcoType === "audio" ||
    name.includes("mp3") ||
    name.includes("audio") ||
    name.includes("track") ||
    name.includes("recording")
  )
    return "mp3";
  return "other";
}

// ---------------------------------------------------------------------------
// Main aggregation
// ---------------------------------------------------------------------------

async function buildServicesPayload(env) {
  const futurePlans = await fetchFuturePlans(env);
  const planMetas = extractUpcomingSundayPlanIds(futurePlans);

  // For each plan, fetch items + attachments concurrently
  const enrichedPlans = await Promise.all(
    planMetas.map(async (meta) => {
      const itemsPayload = await fetchPlanItems(meta.plan_id, env);
      const songs = extractSongsFromItems(itemsPayload);

      // For each song that has an arrangement, fetch its attachments
      await Promise.all(
        songs.map(async (song) => {
          if (!song.song_id || !song.arrangement_id) return;
          const atts = await fetchArrangementAttachments(
            song.song_id,
            song.arrangement_id,
            env
          );

          for (const att of atts) {
            const category = classifyAttachment(att);
            // PCO attachment open_url for download
            const downloadUrl =
              att?.attributes?.streamable
                ? `${PCO_API_BASE}/services/v2/songs/${song.song_id}/arrangements/${song.arrangement_id}/attachments/${att.id}/open`
                : att?.attributes?.file_download_url ||
                  att?.links?.self ||
                  null;

            if (!downloadUrl) continue;

            song.attachments.push({
              attachment_id: att.id,
              filename: att?.attributes?.filename || att?.attributes?.description || "File",
              category,
              download_url: downloadUrl,
              content_type: att?.attributes?.content_type || "",
            });
          }
        })
      );

      return { ...meta, songs };
    })
  );

  return {
    generated_at_utc: new Date().toISOString(),
    timezone: "America/Chicago",
    count: enrichedPlans.length,
    services: enrichedPlans,
  };
}

// ---------------------------------------------------------------------------
// Worker entry
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const cors = getCorsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, 405, cors);
    }

    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return jsonResponse({ ok: true }, 200, cors);
    }

    for (const key of ["PCO_APP_ID", "PCO_SECRET", "PCO_SERVICE_TYPE_ID"]) {
      if (!env[key])
        return jsonResponse({ error: `Missing env var: ${key}` }, 500, cors);
    }

    // Cache TTL defaults to 1 hour
    const cacheTtl = parseInt(env.CACHE_TTL_SECONDS || "3600", 10);
    const cacheKey = new Request(request.url, request);
    const cache = caches.default;

    const cached = await cache.match(cacheKey);
    if (cached) {
      return new Response(cached.body, {
        status: cached.status,
        headers: { ...Object.fromEntries(cached.headers.entries()), ...cors },
      });
    }

    try {
      const body = await buildServicesPayload(env);
      const response = jsonResponse(body, 200, {
        ...cors,
        "cache-control": `public, max-age=${cacheTtl}`,
      });
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (err) {
      return jsonResponse(
        {
          error: "Failed to load services from PCO",
          details: String(err?.message || err),
        },
        502,
        cors
      );
    }
  },
};
