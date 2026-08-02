export type AuthMethod = "application_password" | "jwt";
export type TransportMode = "http" | "stdio";

export interface AppConfig {
  wordpress: {
    baseUrl: string;
    authMethod: AuthMethod;
    username?: string;
    applicationPassword?: string;
    jwtToken?: string;
    contentTypes: string[];
    requestTimeoutMs: number;
    maxMediaBytes: number;
  };
  server: {
    transport: TransportMode;
    host: string;
    port: number;
    mcpPath: string;
    apiKey?: string;
    allowedHosts: string[];
    logLevel: "debug" | "info" | "warn" | "error";
  };
}

export interface WpRendered {
  rendered?: string;
  raw?: string;
}

export interface WpContentItem {
  id: number;
  date?: string;
  modified?: string;
  slug?: string;
  status?: string;
  type?: string;
  link?: string;
  title?: WpRendered;
  content?: WpRendered;
  excerpt?: WpRendered;
  author?: number;
  featured_media?: number;
  categories?: number[];
  tags?: number[];
  parent?: number;
  [key: string]: unknown;
}

export interface WpTerm {
  id: number;
  count?: number;
  description?: string;
  link?: string;
  name?: string;
  slug?: string;
  taxonomy?: string;
  parent?: number;
  [key: string]: unknown;
}

export interface WpComment {
  id: number;
  post?: number;
  parent?: number;
  author?: number;
  author_name?: string;
  author_email?: string;
  date?: string;
  content?: WpRendered;
  link?: string;
  status?: string;
  [key: string]: unknown;
}

export interface WpMedia {
  id: number;
  date?: string;
  slug?: string;
  status?: string;
  type?: string;
  link?: string;
  title?: WpRendered;
  caption?: WpRendered;
  alt_text?: string;
  media_type?: string;
  mime_type?: string;
  source_url?: string;
  [key: string]: unknown;
}
