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

    return text(request, "Not found", 404);
  }
};
