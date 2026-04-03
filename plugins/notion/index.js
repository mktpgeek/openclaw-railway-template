import { definePluginEntry } from "/usr/local/lib/node_modules/openclaw/dist/plugin-sdk/plugin-entry.js";

const DEFAULT_BASE_URL = "https://api.notion.com/v1";
const DEFAULT_NOTION_VERSION = "2026-03-11";

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
  const apiKey = cfg.apiKey || process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
  const baseUrl = (cfg.baseUrl || process.env.NOTION_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const notionVersion = cfg.notionVersion || process.env.NOTION_VERSION || DEFAULT_NOTION_VERSION;
  if (!apiKey) {
    throw new Error("Notion is not configured. Set NOTION_API_KEY in Railway or plugins.entries.notion.config.apiKey.");
  }
  return { apiKey, baseUrl, notionVersion };
}

async function notionFetch(api, path, { method = "GET", query, body } = {}) {
  const { apiKey, baseUrl, notionVersion } = getConfig(api);
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
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": notionVersion,
      "Content-Type": "application/json",
      Accept: "application/json",
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
    throw new Error(`Notion API ${res.status}: ${JSON.stringify(parsed).slice(0, 600)}`);
  }
  return parsed;
}

export default definePluginEntry({
  id: "notion",
  name: "Notion",
  description: "Notion API tools for searching pages, reading pages, and querying databases.",
  register(api) {
    api.registerTool({
      name: "notion_search",
      description: "Search accessible Notion pages and databases by title or text.",
      parameters: schema({
        query: { type: "string", description: "Text query for Notion search." },
        filter_type: { type: "string", enum: ["page", "database"], description: "Limit results to pages or databases." },
        sort_timestamp: { type: "string", enum: ["last_edited_time"], description: "Sort by last edited time." },
        page_size: { type: "integer", minimum: 1, maximum: 100, description: "Maximum number of results to return." }
      }, ["query"]),
      async execute(_id, params) {
        const payload = {
          query: params.query,
          page_size: clamp(params.page_size, 1, 100, 10),
        };
        if (params.filter_type) {
          payload.filter = { value: params.filter_type, property: "object" };
        }
        if (params.sort_timestamp) {
          payload.sort = { direction: "descending", timestamp: params.sort_timestamp };
        }
        const result = await notionFetch(api, "/search", { method: "POST", body: payload });
        return textResult(result);
      },
    });

    api.registerTool({
      name: "notion_get_page",
      description: "Fetch one Notion page by page id.",
      parameters: schema({
        page_id: { type: "string", description: "The Notion page id." }
      }, ["page_id"]),
      async execute(_id, params) {
        const result = await notionFetch(api, `/pages/${encodeURIComponent(params.page_id)}`);
        return textResult(result);
      },
    });

    api.registerTool({
      name: "notion_get_block_children",
      description: "Fetch block children for a page or block in Notion.",
      parameters: schema({
        block_id: { type: "string", description: "The Notion block id or page id." },
        page_size: { type: "integer", minimum: 1, maximum: 100, description: "Maximum number of block children to return." },
        start_cursor: { type: "string", description: "Pagination cursor from a previous response." }
      }, ["block_id"]),
      async execute(_id, params) {
        const result = await notionFetch(api, `/blocks/${encodeURIComponent(params.block_id)}/children`, {
          query: {
            page_size: clamp(params.page_size, 1, 100, 25),
            start_cursor: params.start_cursor,
          },
        });
        return textResult(result);
      },
    });

    api.registerTool({
      name: "notion_query_database",
      description: "Query a Notion database, optionally with a raw filter payload.",
      parameters: schema({
        database_id: { type: "string", description: "The Notion database id." },
        page_size: { type: "integer", minimum: 1, maximum: 100, description: "Maximum number of rows to return." },
        start_cursor: { type: "string", description: "Pagination cursor from a previous response." },
        filter: { type: "object", description: "Raw Notion database filter object." },
        sorts: { type: "array", description: "Raw Notion sorts array." }
      }, ["database_id"]),
      async execute(_id, params) {
        const payload = {
          page_size: clamp(params.page_size, 1, 100, 10),
        };
        if (params.start_cursor) payload.start_cursor = params.start_cursor;
        if (params.filter && typeof params.filter === "object") payload.filter = params.filter;
        if (Array.isArray(params.sorts)) payload.sorts = params.sorts;
        const result = await notionFetch(api, `/databases/${encodeURIComponent(params.database_id)}/query`, {
          method: "POST",
          body: payload,
        });
        return textResult(result);
      },
    });
  },
});
