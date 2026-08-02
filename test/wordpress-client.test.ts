import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { AppConfig } from "../src/types.js";
import { WordPressApiError, WordPressClient } from "../src/wordpress-client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function config(overrides: Partial<AppConfig["wordpress"]> = {}): AppConfig["wordpress"] {
  return {
    baseUrl: "https://wp.example",
    authMethod: "application_password",
    username: "editor",
    applicationPassword: "app pass",
    contentTypes: ["posts", "pages"],
    requestTimeoutMs: 1_000,
    maxMediaBytes: 1024,
    ...overrides,
  };
}

test("uses WordPress Application Password Basic auth and encoded query params", async () => {
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return new Response(JSON.stringify([{ id: 7, title: { rendered: "Hello" } }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new WordPressClient(config());
  const result = await client.listContent("posts", { search: "hello world", per_page: 5 });
  assert.equal(result[0]?.id, 7);
  assert.equal(request?.headers.get("authorization"), `Basic ${Buffer.from("editor:app pass").toString("base64")}`);
  assert.equal(new URL(request?.url ?? "").searchParams.get("search"), "hello world");
});

test("uses bearer auth in JWT compatibility mode", async () => {
  let authorization: string | null = null;
  globalThis.fetch = async (input, init) => {
    authorization = new Request(input, init).headers.get("authorization");
    return new Response("{}", { status: 200 });
  };
  const client = new WordPressClient(config({
    authMethod: "jwt",
    username: undefined,
    applicationPassword: undefined,
    jwtToken: "jwt-token",
  }));
  await client.siteInfo();
  assert.equal(authorization, "Bearer jwt-token");
});

test("turns WordPress errors into structured exceptions", async () => {
  globalThis.fetch = async () => new Response(
    JSON.stringify({ code: "rest_cannot_create", message: "Sorry", data: { status: 403 } }),
    { status: 403 },
  );
  const client = new WordPressClient(config());
  await assert.rejects(
    () => client.createContent("posts", { title: "No" }),
    (error: unknown) => error instanceof WordPressApiError && error.status === 403 && error.code === "rest_cannot_create",
  );
});

test("blocks content types outside the configured allow-list", async () => {
  const client = new WordPressClient(config());
  assert.throws(
    () => client.listContent("users", {}),
    (error: unknown) => error instanceof WordPressApiError && error.code === "content_type_not_allowed",
  );
});
