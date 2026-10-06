/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

export function graphqlPlaygroundHtml(endpointPath: string): string {
  const escapedPath = endpointPath.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>GraphQL Playground</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #FAFAF9; color: #292524; }
    main { max-width: 48rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
    h1 { font-family: Outfit, ui-sans-serif, system-ui, sans-serif; font-size: 1.5rem; font-weight: 600; margin: 0 0 0.35rem; }
    p { color: #57534E; margin: 0 0 1.25rem; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; }
    textarea, pre { width: 100%; box-sizing: border-box; border: 1px solid #E7E5E4; border-radius: 0.75rem; background: #FFFFFF; }
    textarea { min-height: 12rem; padding: 0.85rem 1rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9rem; color: #292524; }
    textarea:focus { outline: 2px solid #FCD34D; border-color: #FCD34D; }
    button { appearance: none; border: 0; border-radius: 999px; background: #FCD34D; color: #292524; font-weight: 600; padding: 0.55rem 1.15rem; cursor: pointer; margin: 0.85rem 0 1.25rem; }
    button:hover { background: #FBBF24; }
    pre { min-height: 10rem; padding: 0.85rem 1rem; overflow: auto; font-size: 0.85rem; }
  </style>
</head>
<body>
  <main>
    <h1>GraphQL Playground</h1>
    <p>Introspection and queries hit <code>${escapedPath}</code> with a 200 OK envelope. Subscriptions use the same URL with the <code>graphql-transport-ws</code> subprotocol.</p>
    <textarea id="query">query Introspection {\n  __schema {\n    queryType { name }\n    types { name kind }\n  }\n}</textarea>
    <button type="button" id="run">Run</button>
    <pre id="result">{}</pre>
  </main>
  <script>
    const endpoint = ${JSON.stringify(endpointPath)};
    document.getElementById("run").addEventListener("click", async () => {
      const query = document.getElementById("query").value;
      const result = document.getElementById("result");
      result.textContent = "Running…";
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ query }),
        });
        const body = await response.json();
        result.textContent = JSON.stringify(body, null, 2);
      } catch (error) {
        result.textContent = error instanceof Error ? error.message : "Request failed";
      }
    });
  </script>
</body>
</html>
`;
}
