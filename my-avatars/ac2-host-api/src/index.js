const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "https://joseph_lien.github.io",
  "https://geosephlien.github.io"
]);

function buildCorsHeaders(request) {
  const origin = request.headers.get("Origin");
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : "*";

  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  };

  if (allowOrigin !== "*") {
    headers["Access-Control-Allow-Credentials"] = "true";
    headers["Vary"] = "Origin";
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
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const payload = `${key}:${expires}`;
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
      return json(request, {
        sessionToken: "mock-session-token",
        clientId: "my-avatars",
        userId: "demo-user-001",
        exp: Math.floor(Date.now() / 1000) + 3600
      });
    }

    if (request.method === "POST" && url.pathname === "/api/ac2/upload-vrm") {
      if (!env.VRM_BUCKET) {
        return json(request, {
          ok: false,
          message: "VRM bucket is not configured."
        }, 500);
      }

      const formData = await request.formData();
      const file = formData.get("file");
      const userId = sanitizePathSegment(formData.get("userId"), "anonymous");

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
      const key = body && typeof body.key === "string" ? body.key : "";
      const userId = sanitizePathSegment(body && body.userId, "anonymous");
      const expectedPrefix = `avatars/${userId}/`;

      if (!key) {
        return json(request, {
          ok: false,
          message: "Missing key."
        }, 400);
      }

      if (!key.startsWith(expectedPrefix)) {
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

      const key = url.searchParams.get("key");
      if (!key) {
        return json(request, {
          ok: false,
          message: "Missing key."
        }, 400);
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

      const userId = sanitizePathSegment(url.searchParams.get("userId"), "anonymous");
      const prefix = `avatars/${userId}/`;
      const listed = await env.VRM_BUCKET.list({ prefix });
      const files = listed.objects.map((object) => ({
        key: object.key,
        size: object.size,
        uploadedAt: object.uploaded,
        fileName: object.key.split("/").pop() || object.key
      }));

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

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("Content-Type", headers.get("Content-Type") || "model/vrm");
      headers.set("Content-Disposition", `attachment; filename="${originalName}"`);

      return new Response(object.body, {
        status: 200,
        headers
      });
    }

    return text(request, "Not found", 404);
  }
};
