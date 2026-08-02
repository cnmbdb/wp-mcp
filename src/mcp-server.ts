import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { AppConfig, WpContentItem, WpMedia } from "./types.js";
import { WordPressApiError, WordPressClient } from "./wordpress-client.js";

const contentStatus = z.enum(["publish", "future", "draft", "pending", "private"]);
const taxonomy = z.enum(["categories", "tags"]);

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function rendered(value: { rendered?: string; raw?: string } | undefined): string {
  return value?.raw ?? value?.rendered ?? "";
}

function summarizeContent(item: WpContentItem): Record<string, unknown> {
  return {
    id: item.id,
    type: item.type,
    status: item.status,
    title: stripHtml(rendered(item.title)),
    slug: item.slug,
    link: item.link,
    date: item.date,
    modified: item.modified,
    excerpt: stripHtml(rendered(item.excerpt)),
    author: item.author,
    featured_media: item.featured_media,
    categories: item.categories,
    tags: item.tags,
    parent: item.parent,
  };
}

function summarizeMedia(item: WpMedia): Record<string, unknown> {
  return {
    id: item.id,
    title: stripHtml(rendered(item.title)),
    slug: item.slug,
    status: item.status,
    link: item.link,
    source_url: item.source_url,
    media_type: item.media_type,
    mime_type: item.mime_type,
    alt_text: item.alt_text,
    caption: stripHtml(rendered(item.caption)),
    date: item.date,
  };
}

function ok(message: string, data: Record<string, unknown> | unknown[]) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: Array.isArray(data) ? { items: data } : data,
  };
}

function knowledgeResult(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function failure(error: unknown) {
  if (error instanceof WordPressApiError) {
    return {
      isError: true,
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          error: error.code ?? "wordpress_api_error",
          message: error.message,
          status: error.status,
          details: error.details,
        }),
      }],
    };
  }
  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        error: "internal_error",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    }],
  };
}

async function safely<T>(operation: () => Promise<T>): Promise<T | ReturnType<typeof failure>> {
  try { return await operation(); } catch (error) { return failure(error); }
}

export function createMcpServer(config: AppConfig, client = new WordPressClient(config.wordpress)): McpServer {
  const server = new McpServer(
    { name: "wordpress-mcp-server", version: "1.0.0" },
    {
      instructions: [
        "Use search and fetch for read-only discovery and citation-friendly retrieval.",
        "Create content as draft unless the user explicitly requests another status.",
        "Before destructive operations, identify the exact object and confirm intent with the user.",
        `Allowed WordPress content types: ${config.wordpress.contentTypes.join(", ")}.`,
      ].join(" "),
    },
  );

  server.registerTool(
    "search",
    {
      title: "Search WordPress",
      description: "Use this when you need to find WordPress posts or pages by a text query before reading or editing them.",
      inputSchema: z.object({ query: z.string().min(1).max(500).describe("Text to search for") }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ query }) => safely(async () => {
      const groups = await Promise.all(config.wordpress.contentTypes.map(async (type) => {
        const items = await client.listContent(type, {
          search: query,
          per_page: 20,
          context: "view",
          orderby: "relevance",
        });
        return items.map((item) => ({
          id: `${type}:${item.id}`,
          title: stripHtml(rendered(item.title)) || `${type} #${item.id}`,
          url: item.link ?? `${config.wordpress.baseUrl}/?p=${item.id}`,
        }));
      }));
      return knowledgeResult({ results: groups.flat().slice(0, 50) });
    }),
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch WordPress content",
      description: "Use this when you have a search result ID such as posts:123 and need its complete citation-ready content.",
      inputSchema: z.object({ id: z.string().regex(/^[a-z0-9_-]+:\d+$/i).describe("Search result ID, for example posts:123") }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ id }) => safely(async () => {
      const [type, rawId] = id.split(":");
      if (!type || !rawId) throw new WordPressApiError("Invalid fetch ID", 400, "invalid_fetch_id");
      const item = await client.getContent(type, Number.parseInt(rawId, 10), "view");
      const title = stripHtml(rendered(item.title)) || `${type} #${item.id}`;
      const text = [title, stripHtml(rendered(item.excerpt)), rendered(item.content)].filter(Boolean).join("\n\n");
      return knowledgeResult({
        id,
        title,
        text,
        url: item.link ?? `${config.wordpress.baseUrl}/?p=${item.id}`,
        metadata: { type, status: item.status, date: item.date, modified: item.modified, author: item.author },
      });
    }),
  );

  server.registerTool(
    "wp_site_info",
    {
      title: "Get WordPress site info",
      description: "Use this when you need to verify the configured WordPress site and inspect its REST API capabilities.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async () => safely(async () => {
      const info = await client.siteInfo();
      return ok("WordPress site information loaded.", {
        name: info.name,
        description: info.description,
        url: info.url,
        home: info.home,
        namespaces: info.namespaces,
        authentication: info.authentication,
        allowed_content_types: config.wordpress.contentTypes,
      });
    }),
  );

  server.registerTool(
    "wp_list_content",
    {
      title: "List WordPress content",
      description: "Use this when you need a filtered list of WordPress posts or pages, including drafts when authorized.",
      inputSchema: z.object({
        type: z.string().default("posts").describe("Allowed REST content type, usually posts or pages"),
        search: z.string().max(500).optional(),
        status: z.union([contentStatus, z.literal("any")]).optional(),
        page: z.number().int().min(1).default(1),
        per_page: z.number().int().min(1).max(100).default(20),
        order: z.enum(["asc", "desc"]).default("desc"),
        orderby: z.enum(["date", "id", "modified", "slug", "title", "relevance"]).default("date"),
        author: z.number().int().positive().optional(),
        categories: z.array(z.number().int().positive()).optional(),
        tags: z.array(z.number().int().positive()).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ type, ...query }) => safely(async () => {
      const items = await client.listContent(type, { ...query, context: "edit" });
      return ok(`Loaded ${items.length} ${type} item(s).`, items.map(summarizeContent));
    }),
  );

  server.registerTool(
    "wp_get_content",
    {
      title: "Get WordPress content",
      description: "Use this when you need the complete editable fields for one WordPress post or page.",
      inputSchema: z.object({
        type: z.string().default("posts"),
        id: z.number().int().positive(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ type, id }) => safely(async () => {
      const item = await client.getContent(type, id);
      return ok(`Loaded ${type} #${id}.`, item);
    }),
  );

  const contentFields = {
    title: z.string().max(10_000).optional(),
    content: z.string().max(2_000_000).optional(),
    excerpt: z.string().max(100_000).optional(),
    slug: z.string().max(200).optional(),
    status: contentStatus.optional(),
    date: z.string().datetime({ offset: true }).optional(),
    author: z.number().int().positive().optional(),
    featured_media: z.number().int().nonnegative().optional(),
    comment_status: z.enum(["open", "closed"]).optional(),
    categories: z.array(z.number().int().positive()).optional(),
    tags: z.array(z.number().int().positive()).optional(),
    parent: z.number().int().nonnegative().optional(),
    sticky: z.boolean().optional(),
  };

  server.registerTool(
    "wp_create_content",
    {
      title: "Create WordPress content",
      description: "Use this when the user wants to create a WordPress post or page. Status defaults to draft for safety.",
      inputSchema: z.object({
        type: z.string().default("posts"),
        ...contentFields,
        title: z.string().min(1).max(10_000),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ type, ...input }) => safely(async () => {
      const item = await client.createContent(type, { status: "draft", ...input });
      return ok(`Created ${type} #${item.id} with status ${item.status}.`, summarizeContent(item));
    }),
  );

  server.registerTool(
    "wp_update_content",
    {
      title: "Update WordPress content",
      description: "Use this when the user wants to change an existing WordPress post or page. Only supplied fields are changed.",
      inputSchema: z.object({
        type: z.string().default("posts"),
        id: z.number().int().positive(),
        ...contentFields,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ type, id, ...input }) => safely(async () => {
      if (Object.keys(input).length === 0) throw new WordPressApiError("No update fields supplied", 400, "empty_update");
      const item = await client.updateContent(type, id, input);
      return ok(`Updated ${type} #${id}.`, summarizeContent(item));
    }),
  );

  server.registerTool(
    "wp_delete_content",
    {
      title: "Delete WordPress content",
      description: "Use this only after confirming the exact post or page to delete. By default the item is moved to trash; force=true permanently deletes it.",
      inputSchema: z.object({
        type: z.string().default("posts"),
        id: z.number().int().positive(),
        force: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ type, id, force }) => safely(async () => {
      const result = await client.deleteContent(type, id, force);
      return ok(force ? `Permanently deleted ${type} #${id}.` : `Moved ${type} #${id} to trash.`, { result });
    }),
  );

  server.registerTool(
    "wp_list_terms",
    {
      title: "List categories or tags",
      description: "Use this when you need to find WordPress category or tag IDs before assigning them to content.",
      inputSchema: z.object({
        taxonomy,
        search: z.string().max(500).optional(),
        page: z.number().int().min(1).default(1),
        per_page: z.number().int().min(1).max(100).default(50),
        hide_empty: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ taxonomy: name, ...query }) => safely(async () => {
      const items = await client.listTerms(name, { ...query, context: "edit" });
      return ok(`Loaded ${items.length} ${name}.`, items);
    }),
  );

  server.registerTool(
    "wp_create_term",
    {
      title: "Create a category or tag",
      description: "Use this when the user wants a new WordPress category or tag.",
      inputSchema: z.object({
        taxonomy,
        name: z.string().min(1).max(200),
        slug: z.string().max(200).optional(),
        description: z.string().max(20_000).optional(),
        parent: z.number().int().nonnegative().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ taxonomy: name, ...input }) => safely(async () => {
      const item = await client.createTerm(name, input);
      return ok(`Created ${name} #${item.id}.`, item);
    }),
  );

  server.registerTool(
    "wp_update_term",
    {
      title: "Update a category or tag",
      description: "Use this when the user wants to rename or edit an existing WordPress category or tag.",
      inputSchema: z.object({
        taxonomy,
        id: z.number().int().positive(),
        name: z.string().min(1).max(200).optional(),
        slug: z.string().max(200).optional(),
        description: z.string().max(20_000).optional(),
        parent: z.number().int().nonnegative().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ taxonomy: name, id, ...input }) => safely(async () => {
      if (Object.keys(input).length === 0) throw new WordPressApiError("No update fields supplied", 400, "empty_update");
      const item = await client.updateTerm(name, id, input);
      return ok(`Updated ${name} #${id}.`, item);
    }),
  );

  server.registerTool(
    "wp_delete_term",
    {
      title: "Delete a category or tag",
      description: "Use this only after confirming the exact WordPress category or tag. WordPress normally requires force=true for term deletion.",
      inputSchema: z.object({ taxonomy, id: z.number().int().positive(), force: z.boolean().default(true) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ taxonomy: name, id, force }) => safely(async () => {
      const result = await client.deleteTerm(name, id, force);
      return ok(`Deleted ${name} #${id}.`, { result });
    }),
  );

  server.registerTool(
    "wp_list_media",
    {
      title: "List WordPress media",
      description: "Use this when you need to find images or other media already uploaded to WordPress.",
      inputSchema: z.object({
        search: z.string().max(500).optional(),
        media_type: z.enum(["image", "video", "text", "application", "audio"]).optional(),
        page: z.number().int().min(1).default(1),
        per_page: z.number().int().min(1).max(100).default(20),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (query) => safely(async () => {
      const items = await client.listMedia({ ...query, context: "edit" });
      return ok(`Loaded ${items.length} media item(s).`, items.map(summarizeMedia));
    }),
  );

  server.registerTool(
    "wp_upload_media",
    {
      title: "Upload WordPress media",
      description: "Use this when the user provides a base64-encoded file to upload to the WordPress media library.",
      inputSchema: z.object({
        filename: z.string().min(1).max(255),
        mime_type: z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i),
        base64: z.string().min(1).describe("Raw base64 without a data: URL prefix"),
        title: z.string().max(10_000).optional(),
        caption: z.string().max(100_000).optional(),
        alt_text: z.string().max(10_000).optional(),
        description: z.string().max(100_000).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ filename, mime_type, base64, ...metadata }) => safely(async () => {
      const normalized = base64.replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
        throw new WordPressApiError("Invalid base64 media data", 400, "invalid_base64");
      }
      let item = await client.uploadMedia(filename, mime_type, Buffer.from(normalized, "base64"));
      if (Object.keys(metadata).length > 0) item = await client.updateMedia(item.id, metadata);
      return ok(`Uploaded media #${item.id}.`, summarizeMedia(item));
    }),
  );

  server.registerTool(
    "wp_update_media",
    {
      title: "Update WordPress media metadata",
      description: "Use this when the user wants to edit a media item's title, caption, alt text, description, or attachment post.",
      inputSchema: z.object({
        id: z.number().int().positive(),
        title: z.string().max(10_000).optional(),
        caption: z.string().max(100_000).optional(),
        alt_text: z.string().max(10_000).optional(),
        description: z.string().max(100_000).optional(),
        post: z.number().int().nonnegative().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, ...input }) => safely(async () => {
      if (Object.keys(input).length === 0) throw new WordPressApiError("No update fields supplied", 400, "empty_update");
      const item = await client.updateMedia(id, input);
      return ok(`Updated media #${id}.`, summarizeMedia(item));
    }),
  );

  server.registerTool(
    "wp_delete_media",
    {
      title: "Delete WordPress media",
      description: "Use this only after confirming the exact media item. force=true permanently removes the file and attachment record.",
      inputSchema: z.object({ id: z.number().int().positive(), force: z.boolean().default(false) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ id, force }) => safely(async () => {
      const result = await client.deleteMedia(id, force);
      return ok(force ? `Permanently deleted media #${id}.` : `Moved media #${id} to trash.`, { result });
    }),
  );

  server.registerTool(
    "wp_list_comments",
    {
      title: "List WordPress comments",
      description: "Use this when you need to review or moderate WordPress comments.",
      inputSchema: z.object({
        post: z.number().int().positive().optional(),
        search: z.string().max(500).optional(),
        status: z.enum(["approve", "hold", "spam", "trash", "all"]).default("all"),
        page: z.number().int().min(1).default(1),
        per_page: z.number().int().min(1).max(100).default(20),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (query) => safely(async () => {
      const items = await client.listComments({ ...query, context: "edit" });
      return ok(`Loaded ${items.length} comment(s).`, items);
    }),
  );

  server.registerTool(
    "wp_update_comment",
    {
      title: "Edit or moderate a WordPress comment",
      description: "Use this when the user wants to edit comment text or change its moderation status.",
      inputSchema: z.object({
        id: z.number().int().positive(),
        content: z.string().max(100_000).optional(),
        status: z.enum(["approved", "hold", "spam", "trash"]).optional(),
        author_name: z.string().max(245).optional(),
        author_email: z.string().email().optional(),
        parent: z.number().int().nonnegative().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, ...input }) => safely(async () => {
      if (Object.keys(input).length === 0) throw new WordPressApiError("No update fields supplied", 400, "empty_update");
      const item = await client.updateComment(id, input);
      return ok(`Updated comment #${id}.`, item);
    }),
  );

  server.registerTool(
    "wp_delete_comment",
    {
      title: "Delete WordPress comment",
      description: "Use this only after confirming the exact comment. By default it is moved to trash; force=true permanently deletes it.",
      inputSchema: z.object({ id: z.number().int().positive(), force: z.boolean().default(false) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ id, force }) => safely(async () => {
      const result = await client.deleteComment(id, force);
      return ok(force ? `Permanently deleted comment #${id}.` : `Moved comment #${id} to trash.`, { result });
    }),
  );

  return server;
}
