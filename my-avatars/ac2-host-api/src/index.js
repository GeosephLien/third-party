function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    }
  });
}

function text(message, status = 200) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=UTF-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    }
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
        }
      });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "ac2-host-api"
      });
    }

    if (request.method === "POST" && url.pathname === "/api/ac2/session") {
      return json({
        sessionToken: "mock-session-token",
        clientId: "my-avatars",
        userId: "demo-user-001",
        exp: Math.floor(Date.now() / 1000) + 3600
      });
    }

    if (request.method === "POST" && url.pathname === "/api/ac2/upload-vrm") {
      return json({
        ok: true,
        message: "Mock upload received"
      });
    }

    return text("Not found", 404);
  }
};
