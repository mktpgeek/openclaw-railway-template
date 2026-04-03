import { definePluginEntry } from "/usr/local/lib/node_modules/openclaw/dist/plugin-sdk/plugin-entry.js";

const DEFAULT_BASE_URL = "https://public-api.granola.ai/v1";
const MAX_PAGE_SIZE = 30;

function jsonSchema(type, properties, required = []) {
  return {
    type,
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

function asTextResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function getClientConfig(api) {
  const pluginConfig = api.config ?? {};
  const apiKey = pluginConfig.apiKey || process.env.GRANOLA_API_KEY || "";
  const baseUrl = (pluginConfig.baseUrl || process.env.GRANOLA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (!apiKey) {
    throw new Error("Granola is not configured. Set GRANOLA_API_KEY in Railway or plugins.entries.granola.config.apiKey.");
  }
  return { apiKey, baseUrl };
}

async function granolaFetch(api, path, params = {}) {
  const { apiKey, baseUrl } = getClientConfig(api);
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Granola API ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json();
}

async function listNotes(api, options = {}) {
  return granolaFetch(api, "/notes", options);
}

async function getNote(api, noteId, includeTranscript = false) {
  const params = includeTranscript ? { include: "transcript" } : {};
  return granolaFetch(api, `/notes/${encodeURIComponent(noteId)}`, params);
}

function summarizeNoteForSearch(note) {
  return [
    note.title || "",
    note.summary_text || "",
    note.summary_markdown || "",
    ...(Array.isArray(note.transcript) ? note.transcript.map((part) => part?.text || "") : []),
  ]
    .join("\n")
    .toLowerCase();
}

async function searchNotes(api, query, options = {}) {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  if (!normalizedQuery) {
    throw new Error("granola_search_notes requires a non-empty query.");
  }

  const daysBack = clamp(options.days_back, 1, 365, 30);
  const limit = clamp(options.limit, 1, 20, 8);
  const includeTranscript = options.include_transcript === true;
  const pageSize = clamp(options.page_size, 1, MAX_PAGE_SIZE, 20);
  const createdAfter = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

  let cursor = undefined;
  let page = 0;
  const hits = [];

  while (page < 5 && hits.length < limit) {
    const batch = await listNotes(api, {
      created_after: createdAfter,
      page_size: pageSize,
      cursor,
    });
    const notes = Array.isArray(batch.notes) ? batch.notes : [];
    for (const note of notes) {
      let candidate = note;
      if (includeTranscript) {
        try {
          candidate = await getNote(api, note.id, true);
        } catch {
          candidate = note;
        }
      }
      const haystack = summarizeNoteForSearch(candidate);
      if (haystack.includes(normalizedQuery)) {
        hits.push(candidate);
        if (hits.length >= limit) break;
      }
    }
    if (!batch.hasMore || !batch.cursor) break;
    cursor = batch.cursor;
    page += 1;
  }

  return {
    query,
    days_back: daysBack,
    include_transcript: includeTranscript,
    results: hits,
  };
}

export default definePluginEntry({
  id: "granola",
  name: "Granola",
  description: "Granola Personal API tools for meeting notes and transcripts.",
  register(api) {
    api.registerTool({
      name: "granola_list_notes",
      description: "List accessible Granola meeting notes with optional date filters and pagination.",
      parameters: jsonSchema(
        "object",
        {
          created_after: { type: "string", description: "Only return notes created after this ISO date or datetime." },
          created_before: { type: "string", description: "Only return notes created before this ISO date or datetime." },
          updated_after: { type: "string", description: "Only return notes updated after this ISO date or datetime." },
          cursor: { type: "string", description: "Pagination cursor from a previous call." },
          page_size: { type: "integer", minimum: 1, maximum: 30, description: "How many notes to return, between 1 and 30." },
        },
      ),
      async execute(_id, params) {
        const result = await listNotes(api, {
          created_after: params.created_after,
          created_before: params.created_before,
          updated_after: params.updated_after,
          cursor: params.cursor,
          page_size: clamp(params.page_size, 1, MAX_PAGE_SIZE, 10),
        });
        return asTextResult(result);
      },
    });

    api.registerTool({
      name: "granola_get_note",
      description: "Fetch one Granola meeting note by id, with optional transcript inclusion.",
      parameters: jsonSchema(
        "object",
        {
          note_id: { type: "string", description: "Granola note id, like not_1d3tmYTlCICgjy." },
          include_transcript: { type: "boolean", description: "Include the note transcript in the response." },
        },
        ["note_id"],
      ),
      async execute(_id, params) {
        const result = await getNote(api, params.note_id, params.include_transcript === true);
        return asTextResult(result);
      },
    });

    api.registerTool({
      name: "granola_search_notes",
      description: "Search recent Granola notes by keyword across titles, summaries, and optionally transcripts.",
      parameters: jsonSchema(
        "object",
        {
          query: { type: "string", description: "Keyword or phrase to search for." },
          days_back: { type: "integer", minimum: 1, maximum: 365, description: "Look back this many days." },
          limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum number of matching notes to return." },
          include_transcript: { type: "boolean", description: "Also inspect note transcripts, not just summaries." },
          page_size: { type: "integer", minimum: 1, maximum: 30, description: "Granola page size to use per fetch." },
        },
        ["query"],
      ),
      async execute(_id, params) {
        const result = await searchNotes(api, params.query, params);
        return asTextResult(result);
      },
    });
  },
});
