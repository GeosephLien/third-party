const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "https://joseph_lien.github.io",
  "https://geosephlien.github.io"
]);
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const ANON_USER_COOKIE = "ac2_anon_user";
const ANON_USER_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const DEFAULT_DEMO_USER_ID = "demo-user-001";

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

function getOrCreateAnonymousUser() {
  return {
    userId: DEFAULT_DEMO_USER_ID,
    setCookieHeader: buildSetCookieHeader(ANON_USER_COOKIE, DEFAULT_DEMO_USER_ID, {
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

function isValidObjectKeyForUser(key, userId) {
  if (typeof key !== "string" || !key) {
    return false;
  }

  return key.startsWith(`avatars/${userId}/`) && !key.includes("..");
}

function sanitizeDownloadFileName(value) {
  const fallback = "avatar.vrm";
  const safeName = String(value || fallback)
    .replace(/[\r\n"]/g, "")
    .replace(/[\\/:*?<>|]+/g, "-")
    .trim();

  return safeName || fallback;
}

async function createSessionToken(secret, userId, expires) {
  const sig = await signSessionToken(secret, userId, expires);
  return `${userId}.${expires}.${sig}`;
}

async function verifySessionToken(secret, token) {
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

  return { userId, exp: expires };
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

      const anonymousUser = getOrCreateAnonymousUser();
      const userId = anonymousUser.userId;
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const headers = {
        "Content-Type": "application/json",
        ...buildCorsHeaders(request)
      };

      if (anonymousUser.setCookieHeader) {
        headers["Set-Cookie"] = anonymousUser.setCookieHeader;
      }

      return new Response(JSON.stringify({
        sessionToken: await createSessionToken(secret, userId, exp),
        clientId: "my-avatars",
        userId,
        exp
      }), {
        status: 200,
        headers
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

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const safeName = sanitizePathSegment(file.name.replace(/\.vrm$/i, ""), "avatar");
      const key = `avatars/${userId}/${timestamp}-${safeName}.vrm`;

      await env.VRM_BUCKET.put(key, file.stream(), {
        httpMetadata: {
          contentType: file.type || "model/vrm"
        },
        customMetadata: {
          originalName: file.name,
          userId
        }
      });

      return json(request, {
        ok: true,
        key,
        fileName: file.name,
        userId,
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

      if (!isValidObjectKeyForUser(key, userId)) {
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

      if (!isValidObjectKeyForUser(key, auth.session.userId)) {
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
      const prefix = `avatars/${userId}/`;
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
        ? object.customMetadata.originalName
        : key.split("/").pop() || "avatar.vrm";
      const fileName = sanitizeDownloadFileName(originalName);

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("Content-Type", headers.get("Content-Type") || "model/vrm");
      headers.set("Content-Disposition", `attachment; filename="${fileName}"`);

      return new Response(object.body, {
        status: 200,
        headers
      });
    }

    return text(request, "Not found", 404);
  }
};
