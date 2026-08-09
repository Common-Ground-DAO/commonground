// Generates docs/api/openapi.json from the server's Joi validators.
//
// Runs INSIDE the backend image (where /dist/validators is compiled), so it
// reads the exact same schemas the server validates requests against — the
// spec cannot drift from enforcement. Emits OpenAPI 3.1 to stdout.
//
//   docker run --rm cryptogram/backend node - < generate-openapi.mjs > docs/api/openapi.json
//
// Scope: request bodies come from the validators (authoritative). Responses
// are typed in TypeScript .d.ts (not runtime-introspectable), so each
// operation carries the standard {status:"OK",data} / {status:"ERROR"}
// envelope with an open `data` schema — documented, not invented.
//
// The generator is deterministic: no timestamps, sorted keys, stable order,
// so the CI drift check (regenerate → git diff must be empty) is meaningful.

import validatorsModule from "/dist/validators/index.js";

const validators = validatorsModule.default ?? validatorsModule;
const API = validators.API;

// Validator domain → REST route prefix. Domains absent here are not REST
// surfaces (Socket, Mediasoup live in the socket/protoo catalogs;
// BaseArticle is shared sub-schema material) and are skipped with a note.
const DOMAIN_TO_ROUTE = {
  User: "User",
  Community: "Community",
  Chat: "Chat",
  Message: "Message",
  Files: "File",
  Contract: "Contract",
  Notification: "Notification",
  Twitter: "Twitter",
  Lukso: "Lukso",
  Accounts: "Accounts",
  CgId: "CgId",
  Plugin: "Plugins",
  Search: "Search",
  Report: "Report",
  Bot: "Bot",
  Feed: "Feed",
};

const NON_REST_DOMAINS = new Set(["Socket", "Mediasoup", "BaseArticle"]);

// ---- Joi describe() → OpenAPI 3.1 schema ----------------------------------

function convert(desc) {
  if (!desc || typeof desc !== "object") return {};
  switch (desc.type) {
    case "object":
      return convertObject(desc);
    case "array":
      return convertArray(desc);
    case "string":
      return convertString(desc);
    case "number":
      return convertNumber(desc);
    case "boolean":
      return withNullable(desc, { type: "boolean" });
    case "date":
      return withNullable(desc, { type: "string", format: "date-time" });
    case "alternatives":
      return convertAlternatives(desc);
    case "any":
    default:
      return convertAny(desc);
  }
}

function allowedValues(desc) {
  // Joi records `.valid(...)` / `.allow(...)` under flags.only + allow[].
  return Array.isArray(desc.allow) ? desc.allow : [];
}

function isOnly(desc) {
  return desc.flags && desc.flags.only === true;
}

function hasNull(desc) {
  return allowedValues(desc).some((v) => v === null);
}

function withNullable(desc, schema) {
  if (hasNull(desc)) {
    // OpenAPI 3.1 nullability = union with "null"
    return { anyOf: [schema, { type: "null" }] };
  }
  return schema;
}

function convertObject(desc) {
  const schema = { type: "object" };
  const properties = {};
  const required = [];
  const keys = desc.keys ?? {};
  for (const name of Object.keys(keys).sort()) {
    const child = keys[name];
    properties[name] = convert(child);
    if (child.flags && child.flags.presence === "required") required.push(name);
  }
  if (Object.keys(properties).length) schema.properties = properties;
  if (required.length) schema.required = required.sort();
  // Joi objects are closed unless .unknown(true)
  schema.additionalProperties = desc.flags?.unknown === true;
  return withNullable(desc, schema);
}

function convertArray(desc) {
  const schema = { type: "array" };
  const items = desc.items ?? [];
  if (items.length === 1) schema.items = convert(items[0]);
  else if (items.length > 1) schema.items = { anyOf: items.map(convert) };
  else schema.items = {};
  for (const rule of desc.rules ?? []) {
    if (rule.name === "max") schema.maxItems = rule.args.limit;
    if (rule.name === "min") schema.minItems = rule.args.limit;
    if (rule.name === "length") schema.minItems = schema.maxItems = rule.args.limit;
    if (rule.name === "unique") schema.uniqueItems = true;
  }
  return withNullable(desc, schema);
}

function convertString(desc) {
  // Pure enum (valid list of strings, only flag) → enum schema
  const values = allowedValues(desc).filter((v) => v !== null && v !== "");
  if (isOnly(desc) && values.length) {
    const enumSchema = { type: "string", enum: values.sort() };
    return withNullable(desc, enumSchema);
  }
  const schema = { type: "string" };
  for (const rule of desc.rules ?? []) {
    if (rule.name === "max") schema.maxLength = rule.args.limit;
    if (rule.name === "min") schema.minLength = rule.args.limit;
    if (rule.name === "length") schema.minLength = schema.maxLength = rule.args.limit;
    if (rule.name === "email") schema.format = "email";
    if (rule.name === "uri") schema.format = "uri";
    if (rule.name === "guid" || rule.name === "uuid") schema.format = "uuid";
    if (rule.name === "hex") schema.pattern = "^[0-9a-fA-F]+$";
    if (rule.name === "pattern" && rule.args?.regex) {
      schema.pattern = String(rule.args.regex).replace(/^\/|\/[a-z]*$/g, "");
    }
  }
  if (allowedValues(desc).includes("")) schema.minLength = 0;
  return withNullable(desc, schema);
}

function convertNumber(desc) {
  const schema = { type: "number" };
  for (const rule of desc.rules ?? []) {
    if (rule.name === "integer") schema.type = "integer";
    if (rule.name === "max") schema.maximum = rule.args.limit;
    if (rule.name === "min") schema.minimum = rule.args.limit;
  }
  if ((desc.flags?.unsafe ?? false) === false && schema.type === "integer") {
    schema.format = "int64";
  }
  return withNullable(desc, schema);
}

function convertAlternatives(desc) {
  const matches = (desc.matches ?? []).map((m) => convert(m.schema)).filter(Boolean);
  if (!matches.length) return {};
  return { anyOf: matches };
}

function convertAny(desc) {
  const values = allowedValues(desc).filter((v) => v !== null);
  if (isOnly(desc) && values.length) return { enum: values };
  return {};
}

// ---- Envelope + document assembly -----------------------------------------

const OK_ENVELOPE = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["OK"] },
    data: {},
  },
  required: ["status"],
};

const ERROR_ENVELOPE = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ERROR"] },
    error: { type: "string", description: "machine error code (srv/common/errors.ts)" },
  },
  required: ["status", "error"],
};

function buildPaths() {
  const paths = {};
  const skipped = [];
  for (const domain of Object.keys(API).sort()) {
    if (NON_REST_DOMAINS.has(domain)) {
      skipped.push(domain);
      continue;
    }
    const prefix = DOMAIN_TO_ROUTE[domain];
    if (!prefix) {
      skipped.push(domain);
      continue;
    }
    const methods = API[domain];
    for (const method of Object.keys(methods).sort()) {
      const validator = methods[method];
      if (!validator || typeof validator.describe !== "function") continue;
      const requestSchema = convert(validator.describe());
      const path = `/api/v2/${prefix}/${method}`;
      paths[path] = {
        post: {
          operationId: `${domain}_${method}`,
          tags: [domain],
          summary: `${prefix}/${method}`,
          requestBody: {
            required: true,
            content: { "application/json": { schema: requestSchema } },
          },
          responses: {
            "200": {
              description:
                "RPC envelope. status OK carries data (shape from the TS API types); status ERROR carries a machine error code. Note: RPC-level errors also use HTTP 200.",
              content: {
                "application/json": {
                  schema: { oneOf: [OK_ENVELOPE, ERROR_ENVELOPE] },
                },
              },
            },
          },
        },
      };
    }
  }
  return { paths, skipped };
}

// Hand-add the non-envelope GET routes (no request body / no validator).
function addGetRoutes(paths) {
  paths["/api/v2/Instance/config"] = {
    get: {
      operationId: "Instance_config",
      tags: ["Instance"],
      summary: "Instance/config",
      description: "Public instance identity/capabilities (bare JSON, no envelope).",
      responses: {
        "200": { description: "InstanceConfig", content: { "application/json": { schema: {} } } },
      },
    },
  };
  paths["/api/v2/Captcha/config"] = {
    get: {
      operationId: "Captcha_config",
      tags: ["Captcha"],
      summary: "Captcha/config",
      description: "The captcha provider this instance verifies against (bare JSON).",
      responses: {
        "200": {
          description: "{ provider }",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { provider: { type: "string", enum: ["altcha", "off", "recaptcha"] } },
                required: ["provider"],
              },
            },
          },
        },
      },
    },
  };
  paths["/api/v2/Captcha/challenge"] = {
    get: {
      operationId: "Captcha_challenge",
      tags: ["Captcha"],
      summary: "Captcha/challenge",
      description: "A fresh ALTCHA v2 PoW challenge (bare JSON; 404 unless provider=altcha).",
      responses: {
        "200": { description: "ALTCHA challenge", content: { "application/json": { schema: {} } } },
        "404": { description: "captcha provider is not altcha" },
      },
    },
  };
}

// Stable stringify: sort object keys everywhere for a deterministic diff.
function stableStringify(value) {
  return JSON.stringify(sortDeep(value), null, 2) + "\n";
}
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

const { paths, skipped } = buildPaths();
addGetRoutes(paths);

const doc = {
  openapi: "3.1.0",
  info: {
    title: "Common Ground API",
    version: "2",
    description:
      "Generated from the server Joi validators (srv/validators). Request bodies are authoritative; response `data` shapes are typed in the TypeScript API namespace and left open here. All RPC methods are POST with the {status,data|error} envelope; RPC errors ride HTTP 200. " +
      `Non-REST validator domains not covered here: ${skipped.join(", ")} (see docs/api/socket-events.md and docs/api/protoo-methods.md).`,
  },
  servers: [{ url: "https://cg.mogged.eu", description: "reference instance" }],
  paths,
  components: {
    schemas: {
      OkEnvelope: OK_ENVELOPE,
      ErrorEnvelope: ERROR_ENVELOPE,
    },
  },
};

process.stdout.write(stableStringify(doc));
