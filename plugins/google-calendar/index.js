import { definePluginEntry } from "/usr/local/lib/node_modules/openclaw/dist/plugin-sdk/plugin-entry.js";

const DEFAULT_BASE_URL = "https://www.googleapis.com/calendar/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function schema(properties, required = []) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function getConfig(api) {
  const cfg = api.config ?? {};
  const clientId = cfg.clientId || process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = cfg.clientSecret || process.env.GOOGLE_CLIENT_SECRET || "";
  const refreshToken = cfg.refreshToken || process.env.GOOGLE_REFRESH_TOKEN || "";
  const calendarId = cfg.calendarId || process.env.GOOGLE_CALENDAR_ID || "primary";
  const baseUrl = (cfg.baseUrl || process.env.GOOGLE_CALENDAR_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Google Calendar is not configured. Set clientId, clientSecret, and refreshToken in plugins.entries.google-calendar.config.",
    );
  }

  return { clientId, clientSecret, refreshToken, calendarId, baseUrl };
}

async function getAccessToken(api) {
  const { clientId, clientSecret, refreshToken } = getConfig(api);
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok || !parsed.access_token) {
    throw new Error(`Google OAuth ${res.status}: ${JSON.stringify(parsed).slice(0, 600)}`);
  }

  return parsed.access_token;
}

async function calendarFetch(api, path, { query, method = "GET", body } = {}) {
  const token = await getAccessToken(api);
  const { baseUrl } = getConfig(api);
  const url = new URL(`${baseUrl}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`Google Calendar API ${res.status}: ${JSON.stringify(parsed).slice(0, 600)}`);
  }

  return parsed;
}

function chooseCalendarId(api, params = {}) {
  return params.calendar_id || getConfig(api).calendarId || "primary";
}

function searchHaystack(event) {
  return [
    event.summary || "",
    event.description || "",
    event.location || "",
    ...(Array.isArray(event.attendees) ? event.attendees.map((a) => `${a.displayName || ""} ${a.email || ""}`) : []),
  ]
    .join("\n")
    .toLowerCase();
}

function normalizeAttendees(attendees) {
  if (!Array.isArray(attendees)) return undefined;
  const normalized = attendees
    .filter((item) => item && typeof item === "object" && item.email)
    .map((item) => {
      const out = { email: String(item.email) };
      if (item.display_name) out.displayName = String(item.display_name);
      if (typeof item.optional === "boolean") out.optional = item.optional;
      return out;
    });
  return normalized.length ? normalized : undefined;
}

function buildEventPayload(params) {
  const payload = {};
  if (params.summary) payload.summary = params.summary;
  if (params.description) payload.description = params.description;
  if (params.location) payload.location = params.location;
  if (params.start || params.start_date) {
    payload.start = params.start_date
      ? { date: params.start_date, timeZone: params.time_zone || undefined }
      : { dateTime: params.start, timeZone: params.time_zone || undefined };
  }
  if (params.end || params.end_date) {
    payload.end = params.end_date
      ? { date: params.end_date, timeZone: params.time_zone || undefined }
      : { dateTime: params.end, timeZone: params.time_zone || undefined };
  }
  const attendees = normalizeAttendees(params.attendees);
  if (attendees) payload.attendees = attendees;
  if (params.visibility) payload.visibility = params.visibility;
  if (params.transparency) payload.transparency = params.transparency;
  if (typeof params.guests_can_modify === "boolean") payload.guestsCanModify = params.guests_can_modify;
  if (typeof params.guests_can_invite_others === "boolean") payload.guestsCanInviteOthers = params.guests_can_invite_others;
  if (typeof params.guests_can_see_other_guests === "boolean") payload.guestsCanSeeOtherGuests = params.guests_can_see_other_guests;
  return payload;
}

export default definePluginEntry({
  id: "google-calendar",
  name: "Google Calendar",
  description: "Google Calendar tools for listing calendars and reading events.",
  register(api) {
    api.registerTool({
      name: "google_calendar_list_calendars",
      description: "List accessible Google Calendars for the connected Google account.",
      parameters: schema({}),
      async execute() {
        const result = await calendarFetch(api, "/users/me/calendarList");
        return textResult(result);
      },
    });

    api.registerTool({
      name: "google_calendar_list_events",
      description: "List upcoming events from a Google Calendar over a given time range.",
      parameters: schema({
        calendar_id: { type: "string", description: "Calendar ID to read. Defaults to the configured calendar or primary." },
        time_min: { type: "string", description: "Lower bound (RFC3339 timestamp)." },
        time_max: { type: "string", description: "Upper bound (RFC3339 timestamp)." },
        q: { type: "string", description: "Google Calendar server-side query string." },
        max_results: { type: "integer", minimum: 1, maximum: 50, description: "Maximum number of events to return." },
        single_events: { type: "boolean", description: "Expand recurring events into single instances." },
        order_by: { type: "string", enum: ["startTime", "updated"], description: "Ordering for the events feed." },
      }),
      async execute(_id, params) {
        const calendarId = chooseCalendarId(api, params);
        const result = await calendarFetch(api, `/calendars/${encodeURIComponent(calendarId)}/events`, {
          query: {
            timeMin: params.time_min,
            timeMax: params.time_max,
            q: params.q,
            maxResults: clamp(params.max_results, 1, 50, 10),
            singleEvents: params.single_events === false ? "false" : "true",
            orderBy: params.order_by || "startTime",
          },
        });
        return textResult(result);
      },
    });

    api.registerTool({
      name: "google_calendar_get_event",
      description: "Fetch one Google Calendar event by calendar id and event id.",
      parameters: schema(
        {
          calendar_id: { type: "string", description: "Calendar ID. Defaults to the configured calendar or primary." },
          event_id: { type: "string", description: "Google Calendar event id." },
        },
        ["event_id"],
      ),
      async execute(_id, params) {
        const calendarId = chooseCalendarId(api, params);
        const result = await calendarFetch(api, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(params.event_id)}`);
        return textResult(result);
      },
    });

    api.registerTool({
      name: "google_calendar_search_events",
      description: "Search recent and upcoming Google Calendar events by keyword.",
      parameters: schema(
        {
          query: { type: "string", description: "Keyword or phrase to search for." },
          calendar_id: { type: "string", description: "Calendar ID. Defaults to the configured calendar or primary." },
          days_back: { type: "integer", minimum: 0, maximum: 365, description: "How many days back to search." },
          days_forward: { type: "integer", minimum: 1, maximum: 365, description: "How many days forward to search." },
          max_results: { type: "integer", minimum: 1, maximum: 20, description: "Maximum number of matches to return." },
        },
        ["query"],
      ),
      async execute(_id, params) {
        const calendarId = chooseCalendarId(api, params);
        const daysBack = clamp(params.days_back, 0, 365, 30);
        const daysForward = clamp(params.days_forward, 1, 365, 30);
        const limit = clamp(params.max_results, 1, 20, 8);
        const now = Date.now();
        const timeMin = new Date(now - daysBack * 24 * 60 * 60 * 1000).toISOString();
        const timeMax = new Date(now + daysForward * 24 * 60 * 60 * 1000).toISOString();

        const result = await calendarFetch(api, `/calendars/${encodeURIComponent(calendarId)}/events`, {
          query: {
            timeMin,
            timeMax,
            maxResults: 50,
            singleEvents: "true",
            orderBy: "startTime",
          },
        });

        const needle = String(params.query).trim().toLowerCase();
        const items = Array.isArray(result.items) ? result.items : [];
        const matches = items.filter((event) => searchHaystack(event).includes(needle)).slice(0, limit);

        return textResult({
          query: params.query,
          calendar_id: calendarId,
          time_min: timeMin,
          time_max: timeMax,
          results: matches,
        });
      },
    });

    api.registerTool({
      name: "google_calendar_create_event",
      description: "Create a Google Calendar event.",
      parameters: schema(
        {
          calendar_id: { type: "string", description: "Calendar ID. Defaults to the configured calendar or primary." },
          summary: { type: "string", description: "Event title." },
          description: { type: "string", description: "Event description." },
          location: { type: "string", description: "Event location." },
          start: { type: "string", description: "RFC3339 start datetime for timed events." },
          end: { type: "string", description: "RFC3339 end datetime for timed events." },
          start_date: { type: "string", description: "YYYY-MM-DD start date for all-day events." },
          end_date: { type: "string", description: "YYYY-MM-DD end date for all-day events." },
          time_zone: { type: "string", description: "IANA timezone like America/Chicago." },
          attendees: {
            type: "array",
            description: "List of attendees with email plus optional display_name and optional flag.",
            items: {
              type: "object",
              properties: {
                email: { type: "string" },
                display_name: { type: "string" },
                optional: { type: "boolean" },
              },
              required: ["email"],
              additionalProperties: false,
            },
          },
          visibility: { type: "string", enum: ["default", "public", "private", "confidential"] },
          transparency: { type: "string", enum: ["opaque", "transparent"] },
          guests_can_modify: { type: "boolean" },
          guests_can_invite_others: { type: "boolean" },
          guests_can_see_other_guests: { type: "boolean" },
        },
        ["summary"],
      ),
      async execute(_id, params) {
        const calendarId = chooseCalendarId(api, params);
        const result = await calendarFetch(api, `/calendars/${encodeURIComponent(calendarId)}/events`, {
          method: "POST",
          body: buildEventPayload(params),
        });
        return textResult(result);
      },
    });

    api.registerTool({
      name: "google_calendar_update_event",
      description: "Update a Google Calendar event by event id.",
      parameters: schema(
        {
          calendar_id: { type: "string", description: "Calendar ID. Defaults to the configured calendar or primary." },
          event_id: { type: "string", description: "Google Calendar event id." },
          summary: { type: "string", description: "Event title." },
          description: { type: "string", description: "Event description." },
          location: { type: "string", description: "Event location." },
          start: { type: "string", description: "RFC3339 start datetime for timed events." },
          end: { type: "string", description: "RFC3339 end datetime for timed events." },
          start_date: { type: "string", description: "YYYY-MM-DD start date for all-day events." },
          end_date: { type: "string", description: "YYYY-MM-DD end date for all-day events." },
          time_zone: { type: "string", description: "IANA timezone like America/Chicago." },
          attendees: {
            type: "array",
            description: "List of attendees with email plus optional display_name and optional flag.",
            items: {
              type: "object",
              properties: {
                email: { type: "string" },
                display_name: { type: "string" },
                optional: { type: "boolean" },
              },
              required: ["email"],
              additionalProperties: false,
            },
          },
          visibility: { type: "string", enum: ["default", "public", "private", "confidential"] },
          transparency: { type: "string", enum: ["opaque", "transparent"] },
          guests_can_modify: { type: "boolean" },
          guests_can_invite_others: { type: "boolean" },
          guests_can_see_other_guests: { type: "boolean" },
        },
        ["event_id"],
      ),
      async execute(_id, params) {
        const calendarId = chooseCalendarId(api, params);
        const current = await calendarFetch(api, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(params.event_id)}`);
        const patch = buildEventPayload(params);
        const merged = { ...current, ...patch };
        const result = await calendarFetch(api, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(params.event_id)}`, {
          method: "PUT",
          body: merged,
        });
        return textResult(result);
      },
    });

    api.registerTool({
      name: "google_calendar_delete_event",
      description: "Delete a Google Calendar event by event id.",
      parameters: schema(
        {
          calendar_id: { type: "string", description: "Calendar ID. Defaults to the configured calendar or primary." },
          event_id: { type: "string", description: "Google Calendar event id." },
        },
        ["event_id"],
      ),
      async execute(_id, params) {
        const calendarId = chooseCalendarId(api, params);
        await calendarFetch(api, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(params.event_id)}`, {
          method: "DELETE",
        });
        return textResult({ ok: true, deleted: true, calendar_id: calendarId, event_id: params.event_id });
      },
    });

    api.registerTool({
      name: "google_calendar_freebusy",
      description: "Check Google Calendar free/busy windows across one or more calendars.",
      parameters: schema(
        {
          time_min: { type: "string", description: "RFC3339 lower bound." },
          time_max: { type: "string", description: "RFC3339 upper bound." },
          calendar_ids: {
            type: "array",
            description: "Calendar IDs to query. Defaults to the configured calendar or primary.",
            items: { type: "string" },
          },
          time_zone: { type: "string", description: "IANA timezone like America/Chicago." },
        },
        ["time_min", "time_max"],
      ),
      async execute(_id, params) {
        const calendarIds = Array.isArray(params.calendar_ids) && params.calendar_ids.length
          ? params.calendar_ids
          : [chooseCalendarId(api, params)];
        const result = await calendarFetch(api, "/freeBusy", {
          method: "POST",
          body: {
            timeMin: params.time_min,
            timeMax: params.time_max,
            timeZone: params.time_zone,
            items: calendarIds.map((id) => ({ id })),
          },
        });
        return textResult(result);
      },
    });
  },
});
