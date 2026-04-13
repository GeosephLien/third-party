const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "https://joseph_lien.github.io",
  "https://geosephlien.github.io"
]);
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const ANON_USER_COOKIE = "ac2_anon_user";
const ANON_USER_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const DEFAULT_TENANT_ID = "third-party";
const DEFAULT_USER_ID = "user-001";
const DEFAULT_CLIENT_ID = "my-avatars";

function buildCorsHeaders(request) {
  const origin = request.headers.get("Origin");
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : null;

  const headers = {
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  };

  if (allowOrigin) {
    headers["Access-Control-Allow-Origin"] = allowOrigin;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers["Vary"] = "Origin";
  } else if (!origin) {
    headers["Access-Control-Allow-Origin"] = "*";
  }

  return headers;
}

function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...buildCorsHeaders(request)
    }
  });
}

function base64UrlEncode(bytes) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function formatAmzDate(date) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8)
  };
}

function normalizeAwsHeaderValue(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

async function sha256Hex(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

async function signHmac(keyBytes, value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, bytes);
  return new Uint8Array(signature);
}

async function deriveAwsSigningKey(secret, dateStamp, region = "auto", service = "s3") {
  const kDate = await signHmac(new TextEncoder().encode(`AWS4${secret}`), dateStamp);
  const kRegion = await signHmac(kDate, region);
  const kService = await signHmac(kRegion, service);
  return signHmac(kService, "aws4_request");
}

function getR2DirectUploadConfig(env) {
  const accountId = String(env.R2_ACCOUNT_ID || "").trim();
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || "").trim();
  const bucketName = String(env.R2_BUCKET_NAME || "ac2-vrm-storage").trim();
  const endpoint = String(env.R2_S3_ENDPOINT || "").trim()
    || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");

  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName || !endpoint) {
    return null;
  }

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucketName,
    endpoint
  };
}

function buildObjectKey(session, fileName) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = sanitizePathSegment(fileName.replace(/\.vrm$/i, ""), "avatar");
  return `${session.tenantId}/accounts/${session.userId}/avatars/${timestamp}-${safeName}.vrm`;
}

function sanitizeUploadFileName(value) {
  return sanitizeDownloadFileName(value).replace(/\.vrm$/i, "") + ".vrm";
}

function encodeStoredFileName(value) {
  return encodeURIComponent(String(value || "avatar.vrm"));
}

function decodeStoredFileName(value) {
  if (typeof value !== "string" || !value) {
    return "avatar.vrm";
  }

  try {
    return decodeURIComponent(value);
  } catch (error) {
    return value;
  }
}

async function createPresignedPutUpload(config, { key, contentType, metadata, expiresIn = 900 }) {
  const endpointUrl = new URL(config.endpoint);
  const { amzDate, dateStamp } = formatAmzDate(new Date());
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
  const canonicalUri = `${endpointUrl.pathname.replace(/\/$/, "")}/${encodeRfc3986(config.bucketName)}/${key.split("/").map(encodeRfc3986).join("/")}`;
  const headers = {
    host: endpointUrl.host,
    "content-type": contentType,
    ...Object.fromEntries(Object.entries(metadata).map(([name, value]) => [name.toLowerCase(), normalizeAwsHeaderValue(value)]))
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name]}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
    "X-Amz-Credential": `${config.accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": signedHeaders
  };
  const canonicalQuery = Object.entries(query)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey
        ? String(leftValue).localeCompare(String(rightValue))
        : leftKey.localeCompare(rightKey)
    )
    .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
    .join("&");
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD"
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest)
  ].join("\n");
  const signingKey = await deriveAwsSigningKey(config.secretAccessKey, dateStamp);
  const signature = toHex(await signHmac(signingKey, stringToSign));
  const finalUrl = new URL(`${config.endpoint.replace(/\/$/, "")}${canonicalUri}`);

  Object.entries({
    ...query,
    "X-Amz-Signature": signature
  }).forEach(([name, value]) => {
    finalUrl.searchParams.set(name, value);
  });

  return {
    url: finalUrl.toString(),
    method: "PUT",
    headers: Object.fromEntries(
      Object.entries(headers)
        .filter(([name]) => name !== "host")
        .map(([name, value]) => [name, value])
    ),
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn
  };
}

async function signDownloadToken(secret, key, expires) {
  return signToken(secret, `${key}:${expires}`);
}

async function signSessionToken(secret, userId, expires) {
  return signToken(secret, `${userId}:${expires}`);
}

async function signToken(secret, payload) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(payload)
  );

  return base64UrlEncode(new Uint8Array(signature));
}

function sanitizePathSegment(value, fallback = "unknown") {
  const normalized = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized || fallback;
}

function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const cookies = {};

  header.split(";").forEach((part) => {
    const trimmed = part.trim();
    if (!trimmed) {
      return;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      return;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    cookies[key] = value;
  });

  return cookies;
}

function buildSetCookieHeader(name, value, options = {}) {
  const parts = [`${name}=${value}`];

  if (options.maxAge != null) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (options.path) {
    parts.push(`Path=${options.path}`);
  }
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  return parts.join("; ");
}

function getOrCreateAnonymousUser(request) {
  const cookies = parseCookies(request);
  const existingUserId = sanitizePathSegment(cookies[ANON_USER_COOKIE], "");
  if (existingUserId) {
    return {
      userId: existingUserId,
      setCookieHeader: null
    };
  }

  const userId = `anon-${crypto.randomUUID()}`;
  return {
    userId,
    setCookieHeader: buildSetCookieHeader(ANON_USER_COOKIE, userId, {
      maxAge: ANON_USER_COOKIE_MAX_AGE,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "None"
    })
  };
}

function getSessionSecret(env) {
  return env.AC2_SESSION_SECRET || env.DOWNLOAD_SIGNING_SECRET || "";
}

function getBearerToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function isValidObjectKeyForSession(key, session) {
  if (typeof key !== "string" || !key) {
    return false;
  }

  return key.startsWith(`${session.tenantId}/accounts/${session.userId}/avatars/`) && !key.includes("..");
}

function sanitizeDownloadFileName(value) {
  const fallback = "avatar.vrm";
  const safeName = String(value || fallback)
    .replace(/[\r\n"]/g, "")
    .replace(/[\\/:*?<>|]+/g, "-")
    .trim();

  return safeName || fallback;
}

function decodeBase64UrlJson(value) {
  try {
    const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))));
  } catch (error) {
    return null;
  }
}

function sanitizeSessionPayload(payload = {}) {
  const userId = sanitizePathSegment(payload.userId, "");
  if (!userId) {
    return null;
  }

  const exp = Number.parseInt(String(payload.exp || ""), 10);
  if (!Number.isFinite(exp)) {
    return null;
  }

  return {
    userId,
    tenantId: sanitizePathSegment(payload.tenantId, DEFAULT_TENANT_ID),
    clientId: sanitizePathSegment(payload.clientId, DEFAULT_CLIENT_ID),
    source: sanitizePathSegment(payload.source, payload.clientId || DEFAULT_CLIENT_ID),
    exp
  };
}

async function createSessionToken(secret, payload) {
  const session = sanitizeSessionPayload(payload);
  if (!session) {
    throw new Error("Invalid session payload.");
  }

  const encodedPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(session)));
  const sig = await signToken(secret, `v2:${encodedPayload}`);
  return `v2.${encodedPayload}.${sig}`;
}

async function verifyLegacySessionToken(secret, token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [rawUserId, rawExpires, sig] = parts;
  const userId = sanitizePathSegment(rawUserId, "");
  const expires = Number.parseInt(rawExpires, 10);

  if (!userId || userId !== rawUserId || !Number.isFinite(expires)) {
    return null;
  }

  if (Math.floor(Date.now() / 1000) > expires) {
    return null;
  }

  const expectedSig = await signSessionToken(secret, userId, expires);
  if (sig !== expectedSig) {
    return null;
  }

  return {
    userId,
    tenantId: DEFAULT_TENANT_ID,
    clientId: DEFAULT_CLIENT_ID,
    source: DEFAULT_CLIENT_ID,
    exp: expires
  };
}

async function verifySessionToken(secret, token) {
  const parts = String(token || "").split(".");
  if (parts.length === 3 && parts[0] === "v2") {
    const payload = decodeBase64UrlJson(parts[1]);
    const session = sanitizeSessionPayload(payload);
    if (!session) {
      return null;
    }

    if (Math.floor(Date.now() / 1000) > session.exp) {
      return null;
    }

    const expectedSig = await signToken(secret, `v2:${parts[1]}`);
    if (parts[2] !== expectedSig) {
      return null;
    }

    return session;
  }

  return verifyLegacySessionToken(secret, token);
}

async function parseSessionRequest(request) {
  return request.json().catch(() => null);
}

function createSessionPayload(body) {
  const userId = sanitizePathSegment(body && body.userId, DEFAULT_USER_ID);
  const source = sanitizePathSegment(body && body.source, DEFAULT_CLIENT_ID);
  const clientId = sanitizePathSegment(body && body.clientId, source || DEFAULT_CLIENT_ID);
  const tenantId = sanitizePathSegment(body && body.tenantId, DEFAULT_TENANT_ID);
  const exp = Math.floor(Date.now() / 1000) + 3600;

  return {
    userId,
    tenantId,
    clientId,
    source,
    exp
  };
}

async function getAuthorizedSession(request, env) {
  const secret = getSessionSecret(env);
  if (!secret) {
    return {
      error: json(request, {
        ok: false,
        message: "Session signing secret is not configured."
      }, 500)
    };
  }

  const session = await verifySessionToken(secret, getBearerToken(request));
  if (!session) {
    return {
      error: json(request, {
        ok: false,
        message: "Invalid or expired session."
      }, 401)
    };
  }

  return { session };
}

function text(request, message, status = 200) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=UTF-8",
      ...buildCorsHeaders(request)
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(request)
      });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return json(request, {
        ok: true,
        service: "ac2-host-api"
      });
    }

    if (request.method === "POST" && url.pathname === "/api/ac2/session") {
      const secret = getSessionSecret(env);
      if (!secret) {
        return json(request, {
          ok: false,
          message: "Session signing secret is not configured."
        }, 500);
      }

      const body = await parseSessionRequest(request);
      const anonymousUser = getOrCreateAnonymousUser(request);
      const sessionPayload = createSessionPayload(body, anonymousUser);
      const headers = {
        "Content-Type": "application/json",
        ...buildCorsHeaders(request)
      };

      if (anonymousUser.setCookieHeader) {
        headers["Set-Cookie"] = anonymousUser.setCookieHeader;
      }

      return new Response(JSON.stringify({
        sessionToken: await createSessionToken(secret, sessionPayload),
        userId: sessionPayload.userId,
        tenantId: sessionPayload.tenantId,
        clientId: sessionPayload.clientId,
        source: sessionPayload.source,
        exp: sessionPayload.exp
      }), {
        status: 200,
        headers
      });
    }

    if (request.method === "POST" && url.pathname === "/api/ac2/upload-ticket") {
      const directUploadConfig = getR2DirectUploadConfig(env);
      if (!directUploadConfig) {
        return json(request, {
          ok: false,
          message: "Direct upload is not configured."
        }, 500);
      }

      const auth = await getAuthorizedSession(request, env);
      if (auth.error) {
        return auth.error;
      }

      const body = await request.json().catch(() => null);
      const fileName = sanitizeUploadFileName(body && typeof body.fileName === "string" ? body.fileName : "avatar.vrm");
      const contentType = typeof body?.contentType === "string" && body.contentType.trim()
        ? body.contentType.trim()
        : "model/vrm";
      const size = Number.parseInt(String(body && body.size != null ? body.size : ""), 10);
      const userId = auth.session.userId;

      if (!/\.vrm$/i.test(fileName)) {
        return json(request, {
          ok: false,
          message: "Only .vrm files are supported."
        }, 400);
      }

      if (!Number.isFinite(size) || size <= 0) {
        return json(request, {
          ok: false,
          message: "Missing VRM file size."
        }, 400);
      }

      if (size > MAX_UPLOAD_BYTES) {
        return json(request, {
          ok: false,
          message: "VRM file is too large."
        }, 413);
      }

      const key = buildObjectKey(auth.session, fileName);
      const upload = await createPresignedPutUpload(directUploadConfig, {
        key,
        contentType,
        metadata: {
          "x-amz-meta-original-name": encodeStoredFileName(fileName),
          "x-amz-meta-user-id": userId,
          "x-amz-meta-tenant-id": auth.session.tenantId
        }
      });

      return json(request, {
        ok: true,
        key,
        fileName,
        userId,
        tenantId: auth.session.tenantId,
        upload
      });
    }

    if (request.method === "POST" && url.pathname === "/api/ac2/finalize-upload") {
      if (!env.VRM_BUCKET) {
        return json(request, {
          ok: false,
          message: "VRM bucket is not configured."
        }, 500);
      }

      const auth = await getAuthorizedSession(request, env);
      if (auth.error) {
        return auth.error;
      }

      const body = await request.json().catch(() => null);
      const key = body && typeof body.key === "string" ? body.key : "";
      const userId = auth.session.userId;

      if (!key) {
        return json(request, {
          ok: false,
          message: "Missing key."
        }, 400);
      }

      if (!isValidObjectKeyForSession(key, auth.session)) {
        return json(request, {
          ok: false,
          message: "Key does not belong to the current user."
        }, 403);
      }

      const object = await env.VRM_BUCKET.head(key);
      if (!object) {
        return json(request, {
          ok: false,
          message: "Uploaded VRM was not found."
        }, 404);
      }

      const originalName = object.customMetadata && object.customMetadata.originalName
        ? sanitizeDownloadFileName(decodeStoredFileName(object.customMetadata.originalName))
        : sanitizeDownloadFileName(body && typeof body.fileName === "string" ? body.fileName : key.split("/").pop() || "avatar.vrm");

      return json(request, {
        ok: true,
        key,
        fileName: originalName,
        userId,
        tenantId: auth.session.tenantId,
        size: object.size,
        uploadedAt: object.uploaded,
        etag: object.httpEtag || body?.etag || "",
        message: "VRM uploaded."
      });
    }

    if (request.method === "POST" && url.pathname === "/api/ac2/upload-vrm") {
      if (!env.VRM_BUCKET) {
        return json(request, {
          ok: false,
          message: "VRM bucket is not configured."
        }, 500);
      }

      const auth = await getAuthorizedSession(request, env);
      if (auth.error) {
        return auth.error;
      }

      const formData = await request.formData();
      const file = formData.get("file");
      const userId = auth.session.userId;

      if (!(file instanceof File)) {
        return json(request, {
          ok: false,
          message: "Missing VRM file."
        }, 400);
      }

      if (!file.name || !/\.vrm$/i.test(file.name)) {
        return json(request, {
          ok: false,
          message: "Only .vrm files are supported."
        }, 400);
      }

      if (file.size > MAX_UPLOAD_BYTES) {
        return json(request, {
          ok: false,
          message: "VRM file is too large."
        }, 413);
      }

      const key = buildObjectKey(auth.session, file.name);

      await env.VRM_BUCKET.put(key, file.stream(), {
        httpMetadata: {
          contentType: file.type || "model/vrm"
        },
        customMetadata: {
          originalName: encodeStoredFileName(file.name),
          userId,
          tenantId: auth.session.tenantId
        }
      });

      return json(request, {
        ok: true,
        key,
        fileName: file.name,
        userId,
        tenantId: auth.session.tenantId,
        message: "VRM uploaded."
      });
    }

    if (request.method === "POST" && url.pathname === "/api/ac2/delete-vrm") {
      if (!env.VRM_BUCKET) {
        return json(request, {
          ok: false,
          message: "VRM bucket is not configured."
        }, 500);
      }

      const body = await request.json().catch(() => null);
      const auth = await getAuthorizedSession(request, env);
      if (auth.error) {
        return auth.error;
      }

      const key = body && typeof body.key === "string" ? body.key : "";
      const userId = auth.session.userId;

      if (!key) {
        return json(request, {
          ok: false,
          message: "Missing key."
        }, 400);
      }

      if (!isValidObjectKeyForSession(key, auth.session)) {
        return json(request, {
          ok: false,
          message: "Key does not belong to the current user."
        }, 403);
      }

      await env.VRM_BUCKET.delete(key);

      return json(request, {
        ok: true,
        key,
        userId,
        tenantId: auth.session.tenantId,
        message: "VRM deleted."
      });
    }

    if (request.method === "GET" && url.pathname === "/api/ac2/download-url") {
      if (!env.DOWNLOAD_SIGNING_SECRET) {
        return json(request, {
          ok: false,
          message: "Download signing secret is not configured."
        }, 500);
      }

      const auth = await getAuthorizedSession(request, env);
      if (auth.error) {
        return auth.error;
      }

      const key = url.searchParams.get("key");
      if (!key) {
        return json(request, {
          ok: false,
          message: "Missing key."
        }, 400);
      }

      if (!isValidObjectKeyForSession(key, auth.session)) {
        return json(request, {
          ok: false,
          message: "Key does not belong to the current user."
        }, 403);
      }

      const expiresIn = Math.min(
        Math.max(Number.parseInt(url.searchParams.get("expiresIn") || "900", 10), 60),
        3600
      );
      const expires = Math.floor(Date.now() / 1000) + expiresIn;
      const sig = await signDownloadToken(env.DOWNLOAD_SIGNING_SECRET, key, expires);
      const downloadUrl = `${url.origin}/api/ac2/download?key=${encodeURIComponent(key)}&expires=${expires}&sig=${encodeURIComponent(sig)}`;

      return json(request, {
        ok: true,
        key,
        expires,
        url: downloadUrl
      });
    }

    if (request.method === "GET" && url.pathname === "/api/ac2/files") {
      if (!env.VRM_BUCKET) {
        return json(request, {
          ok: false,
          message: "VRM bucket is not configured."
        }, 500);
      }

      const auth = await getAuthorizedSession(request, env);
      if (auth.error) {
        return auth.error;
      }

      const requestedUserId = sanitizePathSegment(url.searchParams.get("userId"), auth.session.userId);
      if (requestedUserId !== auth.session.userId) {
        return json(request, {
          ok: false,
          message: "Requested user does not match the current session."
        }, 403);
      }

      const userId = auth.session.userId;
      const prefix = `${auth.session.tenantId}/accounts/${userId}/avatars/`;
      const files = [];
      let cursor = undefined;

      do {
        const listed = await env.VRM_BUCKET.list({ prefix, cursor });
        listed.objects.forEach((object) => {
          files.push({
            key: object.key,
            size: object.size,
            uploadedAt: object.uploaded,
            fileName: object.key.split("/").pop() || object.key
          });
        });
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);

      files.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());

      return json(request, {
        ok: true,
        userId,
        tenantId: auth.session.tenantId,
        files
      });
    }

    if (request.method === "GET" && url.pathname === "/api/ac2/download") {
      if (!env.DOWNLOAD_SIGNING_SECRET) {
        return text(request, "Download signing secret is not configured.", 500);
      }

      const key = url.searchParams.get("key");
      const expires = Number.parseInt(url.searchParams.get("expires") || "", 10);
      const sig = url.searchParams.get("sig");

      if (!key || !Number.isFinite(expires) || !sig) {
        return text(request, "Missing download signature parameters.", 400);
      }

      if (Math.floor(Date.now() / 1000) > expires) {
        return text(request, "Download URL expired.", 403);
      }

      const expectedSig = await signDownloadToken(env.DOWNLOAD_SIGNING_SECRET, key, expires);
      if (sig !== expectedSig) {
        return text(request, "Invalid download signature.", 403);
      }

      if (!env.VRM_BUCKET) {
        return text(request, "VRM bucket is not configured.", 500);
      }

      const object = await env.VRM_BUCKET.get(key);
      if (!object) {
        return text(request, "Object not found.", 404);
      }

      const originalName = object.customMetadata && object.customMetadata.originalName
        ? decodeStoredFileName(object.customMetadata.originalName)
        : key.split("/").pop() || "avatar.vrm";
      const fileName = sanitizeDownloadFileName(originalName);

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("Content-Type", headers.get("Content-Type") || "model/vrm");
      headers.set("Content-Disposition", `attachment; filename="${fileName}"`);
      Object.entries(buildCorsHeaders(request)).forEach(([key, value]) => {
        headers.set(key, value);
      });

      return new Response(object.body, {
        status: 200,
        headers
      });
    }

    return text(request, "Not found", 404);
  }
};
