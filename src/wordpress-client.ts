import type { AppConfig, WpComment, WpContentItem, WpMedia, WpTerm } from "./types.js";

export class WordPressApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "WordPressApiError";
  }
}

type QueryValue = string | number | boolean | Array<string | number> | undefined;

export class WordPressClient {
  private readonly apiBase: string;

  constructor(private readonly config: AppConfig["wordpress"]) {
    this.apiBase = `${config.baseUrl}/wp-json`;
  }

  private authHeader(): string {
    if (this.config.authMethod === "jwt") {
      return `Bearer ${this.config.jwtToken}`;
    }
    const credentials = Buffer.from(
      `${this.config.username}:${this.config.applicationPassword}`,
      "utf8",
    ).toString("base64");
    return `Basic ${credentials}`;
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): URL {
    if (!path.startsWith("/") || path.includes("..")) {
      throw new Error("WordPress API path must be absolute and cannot contain '..'");
    }
    const url = new URL(`${this.apiBase}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
    return url;
  }

  async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "DELETE";
      query?: Record<string, QueryValue>;
      json?: unknown;
      body?: BodyInit;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    headers.set("Authorization", this.authHeader());
    headers.set("User-Agent", "wordpress-mcp-server/1.0.0");

    let body = options.body;
    if (options.json !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.json);
    }

    try {
      const requestInit: RequestInit = {
        method: options.method ?? "GET",
        headers,
        signal: controller.signal,
      };
      if (body !== undefined) requestInit.body = body;
      const response = await fetch(this.buildUrl(path, options.query), requestInit);
      const text = await response.text();
      let data: unknown = null;
      if (text) {
        try { data = JSON.parse(text); } catch { data = text; }
      }
      if (!response.ok) {
        const payload = data as { code?: string; message?: string; data?: unknown } | null;
        throw new WordPressApiError(
          payload?.message || `WordPress returned HTTP ${response.status}`,
          response.status,
          payload?.code,
          payload?.data ?? data,
        );
      }
      return data as T;
    } catch (error) {
      if (error instanceof WordPressApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new WordPressApiError("WordPress request timed out", 504, "request_timeout");
      }
      throw new WordPressApiError(
        error instanceof Error ? error.message : "WordPress request failed",
        502,
        "request_failed",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  assertContentType(type: string): string {
    if (!this.config.contentTypes.includes(type)) {
      throw new WordPressApiError(
        `Content type '${type}' is not allowed. Allowed: ${this.config.contentTypes.join(", ")}`,
        400,
        "content_type_not_allowed",
      );
    }
    return type;
  }

  listContent(type: string, query: Record<string, QueryValue>): Promise<WpContentItem[]> {
    return this.request(`/wp/v2/${this.assertContentType(type)}`, { query });
  }

  getContent(type: string, id: number, context: "view" | "edit" = "edit"): Promise<WpContentItem> {
    return this.request(`/wp/v2/${this.assertContentType(type)}/${id}`, { query: { context } });
  }

  createContent(type: string, input: Record<string, unknown>): Promise<WpContentItem> {
    return this.request(`/wp/v2/${this.assertContentType(type)}`, { method: "POST", json: input });
  }

  updateContent(type: string, id: number, input: Record<string, unknown>): Promise<WpContentItem> {
    return this.request(`/wp/v2/${this.assertContentType(type)}/${id}`, { method: "POST", json: input });
  }

  deleteContent(type: string, id: number, force: boolean): Promise<unknown> {
    return this.request(`/wp/v2/${this.assertContentType(type)}/${id}`, {
      method: "DELETE",
      query: { force },
    });
  }

  listTerms(taxonomy: "categories" | "tags", query: Record<string, QueryValue>): Promise<WpTerm[]> {
    return this.request(`/wp/v2/${taxonomy}`, { query });
  }

  createTerm(taxonomy: "categories" | "tags", input: Record<string, unknown>): Promise<WpTerm> {
    return this.request(`/wp/v2/${taxonomy}`, { method: "POST", json: input });
  }

  updateTerm(taxonomy: "categories" | "tags", id: number, input: Record<string, unknown>): Promise<WpTerm> {
    return this.request(`/wp/v2/${taxonomy}/${id}`, { method: "POST", json: input });
  }

  deleteTerm(taxonomy: "categories" | "tags", id: number, force: boolean): Promise<unknown> {
    return this.request(`/wp/v2/${taxonomy}/${id}`, { method: "DELETE", query: { force } });
  }

  listMedia(query: Record<string, QueryValue>): Promise<WpMedia[]> {
    return this.request("/wp/v2/media", { query });
  }

  uploadMedia(filename: string, mimeType: string, bytes: Uint8Array): Promise<WpMedia> {
    if (bytes.byteLength > this.config.maxMediaBytes) {
      throw new WordPressApiError(
        `Media exceeds MAX_MEDIA_BYTES (${this.config.maxMediaBytes})`,
        413,
        "media_too_large",
      );
    }
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return this.request("/wp/v2/media", {
      method: "POST",
      body: new Blob([arrayBuffer], { type: mimeType }),
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  }

  updateMedia(id: number, input: Record<string, unknown>): Promise<WpMedia> {
    return this.request(`/wp/v2/media/${id}`, { method: "POST", json: input });
  }

  deleteMedia(id: number, force: boolean): Promise<unknown> {
    return this.request(`/wp/v2/media/${id}`, { method: "DELETE", query: { force } });
  }

  listComments(query: Record<string, QueryValue>): Promise<WpComment[]> {
    return this.request("/wp/v2/comments", { query });
  }

  updateComment(id: number, input: Record<string, unknown>): Promise<WpComment> {
    return this.request(`/wp/v2/comments/${id}`, { method: "POST", json: input });
  }

  deleteComment(id: number, force: boolean): Promise<unknown> {
    return this.request(`/wp/v2/comments/${id}`, { method: "DELETE", query: { force } });
  }

  siteInfo(): Promise<Record<string, unknown>> {
    return this.request("/");
  }
}
