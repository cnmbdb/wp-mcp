import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadConfig } from "../src/config.js";

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
});

test("loads native Application Password configuration", () => {
  Object.assign(process.env, {
    WP_URL: "https://example.com/",
    WP_AUTH_METHOD: "application_password",
    WP_USERNAME: "editor",
    WP_APPLICATION_PASSWORD: "abcd efgh",
    WP_CONTENT_TYPES: "posts,pages,news",
  });
  const config = loadConfig();
  assert.equal(config.wordpress.baseUrl, "https://example.com");
  assert.equal(config.wordpress.authMethod, "application_password");
  assert.deepEqual(config.wordpress.contentTypes, ["posts", "pages", "news"]);
});

test("requires a JWT token in JWT mode", () => {
  Object.assign(process.env, {
    WP_URL: "https://example.com",
    WP_AUTH_METHOD: "jwt",
    WP_JWT_TOKEN: "",
  });
  assert.throws(() => loadConfig(), /WP_JWT_TOKEN/);
});

test("rejects unsafe content type paths", () => {
  Object.assign(process.env, {
    WP_URL: "https://example.com",
    WP_AUTH_METHOD: "application_password",
    WP_USERNAME: "editor",
    WP_APPLICATION_PASSWORD: "secret",
    WP_CONTENT_TYPES: "posts,../users",
  });
  assert.throws(() => loadConfig(), /Invalid WordPress content type/);
});
