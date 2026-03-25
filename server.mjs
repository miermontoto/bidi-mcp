#!/usr/bin/env node
/**
 * bidi-mcp -- servidor MCP que conecta a Zen/Firefox via WebDriver BiDi
 *
 * permite a Claude Code evaluar JS, capturar screenshots, navegar y leer
 * la consola del navegador en tiempo real.
 *
 * requiere: Node >= 22 (WebSocket built-in), Zen lanzado con --remote-debugging-port=9222
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ─── configuración ──────────────────────────────────────────────────────────────

const BIDI_URL = process.env.ZEN_BIDI_URL || "ws://127.0.0.1:9222/session";
const CONNECT_TIMEOUT_MS = 3000;
const CALL_TIMEOUT_MS = 10000;
const MAX_CONSOLE_BUFFER = 200;
const MAX_RESULT_LENGTH = 100_000;

// ─── estado global ──────────────────────────────────────────────────────────────

let ws = null;
let nextId = 0;
let hasSession = false;
const pending = new Map(); // id -> { resolve, reject, timer }
const consoleBuffer = [];

// ─── cliente BiDi ───────────────────────────────────────────────────────────────

const log = (...args) => process.stderr.write(args.join(" ") + "\n");

function connect() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout connecting to ${BIDI_URL} -- is Zen running with --remote-debugging-port?`));
      try { socket.close(); } catch {}
    }, CONNECT_TIMEOUT_MS);

    const socket = new WebSocket(BIDI_URL);

    socket.addEventListener("open", async () => {
      clearTimeout(timer);
      ws = socket;
      log("[bidi-mcp] connected to", BIDI_URL);
      try {
        // crear sesion BiDi (requerido antes de cualquier comando)
        const session = await bidiSend("session.new", { capabilities: {} });
        hasSession = true;
        log("[bidi-mcp] session created:", session.sessionId);
        // suscribirse a eventos de consola
        await bidiSend("session.subscribe", { events: ["log.entryAdded"] });
      } catch (e) {
        log("[bidi-mcp] warning: session setup error:", e.message);
        // si hay sesion huerfana, no podemos hacer nada hasta que se reinicie Zen
      }
      resolve(socket);
    });

    socket.addEventListener("message", (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      // respuesta a un comando
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve: res, reject: rej, timer: t } = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(t);
        if (msg.type === "error") {
          rej(new Error(msg.message || msg.error || JSON.stringify(msg)));
        } else {
          res(msg.result);
        }
        return;
      }

      // evento
      if (msg.method === "log.entryAdded") {
        const p = msg.params;
        consoleBuffer.push({
          level: p.level,
          text: p.text,
          timestamp: p.timestamp,
          source: p.source?.context,
        });
        if (consoleBuffer.length > MAX_CONSOLE_BUFFER) consoleBuffer.shift();
      }
    });

    socket.addEventListener("close", () => {
      log("[bidi-mcp] disconnected");
      ws = null;
      hasSession = false;
      rejectAllPending("connection closed");
    });

    socket.addEventListener("error", (e) => {
      clearTimeout(timer);
      ws = null;
      rejectAllPending("connection error");
      reject(new Error(`cannot connect to ${BIDI_URL} -- is Zen running with --remote-debugging-port?`));
    });
  });
}

function rejectAllPending(reason) {
  for (const [id, { reject: rej, timer }] of pending) {
    clearTimeout(timer);
    rej(new Error(reason));
  }
  pending.clear();
}

async function ensureConnected() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  await connect();
}

function bidiSend(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error("not connected"));
    }
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// ─── helpers ────────────────────────────────────────────────────────────────────

async function getActiveContext(tabId) {
  if (tabId) return tabId;
  const result = await bidiSend("browsingContext.getTree", {});
  const contexts = result.contexts;
  if (!contexts?.length) throw new Error("no browser contexts found");
  return contexts[0].context;
}

function formatBidiValue(result) {
  if (!result) return "undefined";
  const { type, value } = result;
  if (type === "string") return value;
  if (type === "number" || type === "boolean") return String(value);
  if (type === "null") return "null";
  if (type === "undefined") return "undefined";
  if (type === "bigint") return `${value}n`;
  if (type === "array" || type === "object" || type === "map" || type === "set") {
    const serialized = JSON.stringify(value, null, 2);
    return serialized.length > MAX_RESULT_LENGTH
      ? serialized.slice(0, MAX_RESULT_LENGTH) + "\n... (truncated)"
      : serialized;
  }
  if (type === "node") return result.sharedId || JSON.stringify(result);
  // fallback
  return value !== undefined ? String(value) : JSON.stringify(result);
}

function errResult(msg) {
  return { content: [{ type: "text", text: msg }], isError: true };
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

// ─── herramientas MCP ───────────────────────────────────────────────────────────

const server = new McpServer({ name: "zen-bidi", version: "1.0.0" });

// evaluar JS
server.tool(
  "evaluate",
  "Execute JavaScript in the active browser tab and return the result",
  { expression: z.string().describe("JS expression to evaluate"), tab: z.string().optional().describe("browsing context ID (from tabs tool)") },
  async ({ expression, tab }) => {
    try {
      await ensureConnected();
      const ctx = await getActiveContext(tab);
      const result = await bidiSend("script.evaluate", {
        expression,
        target: { context: ctx },
        awaitPromise: true,
        resultOwnership: "none",
      });
      if (result.exceptionDetails) {
        const text = result.exceptionDetails.text
          || result.exceptionDetails.exception?.value
          || JSON.stringify(result.exceptionDetails);
        return errResult(`Exception: ${text}`);
      }
      return textResult(formatBidiValue(result.result));
    } catch (e) {
      return errResult(e.message);
    }
  }
);

// screenshot
server.tool(
  "screenshot",
  "Capture a PNG screenshot of the browser tab",
  { tab: z.string().optional().describe("browsing context ID") },
  async ({ tab }) => {
    try {
      await ensureConnected();
      const ctx = await getActiveContext(tab);
      const result = await bidiSend("browsingContext.captureScreenshot", { context: ctx });
      return { content: [{ type: "image", data: result.data, mimeType: "image/png" }] };
    } catch (e) {
      return errResult(e.message);
    }
  }
);

// navegar
server.tool(
  "navigate",
  "Navigate the browser tab to a URL",
  { url: z.string().describe("URL to navigate to"), tab: z.string().optional().describe("browsing context ID") },
  async ({ url, tab }) => {
    try {
      await ensureConnected();
      const ctx = await getActiveContext(tab);
      const result = await bidiSend("browsingContext.navigate", { context: ctx, url, wait: "complete" });
      return textResult(`navigated to ${result.url}`);
    } catch (e) {
      return errResult(e.message);
    }
  }
);

// recargar
server.tool(
  "reload",
  "Reload the current page in the browser tab",
  { tab: z.string().optional().describe("browsing context ID") },
  async ({ tab }) => {
    try {
      await ensureConnected();
      const ctx = await getActiveContext(tab);
      await bidiSend("browsingContext.reload", { context: ctx, wait: "complete" });
      return textResult("page reloaded");
    } catch (e) {
      return errResult(e.message);
    }
  }
);

// listar tabs
server.tool(
  "tabs",
  "List all open browser tabs with their URLs and titles",
  {},
  async () => {
    try {
      await ensureConnected();
      const result = await bidiSend("browsingContext.getTree", {});
      // solo contextos top-level (sin parent), ignorar iframes
      const tabs = (result.contexts || [])
        .filter((ctx) => ctx.parent === null || ctx.parent === undefined)
        .map((ctx) => ({
          id: ctx.context,
          url: ctx.url,
        }));
      return textResult(JSON.stringify(tabs, null, 2));
    } catch (e) {
      return errResult(e.message);
    }
  }
);

// mensajes de consola
server.tool(
  "console_messages",
  "Get recent console messages from the browser (buffered since connection)",
  {
    limit: z.number().optional().default(50).describe("max messages to return"),
    level: z.enum(["all", "log", "warn", "error", "info", "debug"]).optional().default("all").describe("filter by log level"),
  },
  async ({ limit, level }) => {
    const filtered = level === "all"
      ? consoleBuffer
      : consoleBuffer.filter((e) => e.level === level);
    const entries = filtered.slice(-limit);
    if (!entries.length) return textResult("(no console messages captured)");
    const lines = entries.map((e) => {
      const ts = e.timestamp ? new Date(e.timestamp).toISOString().slice(11, 23) : "???";
      return `[${ts}] ${(e.level || "log").padEnd(5)} ${e.text}`;
    });
    return textResult(lines.join("\n"));
  }
);

// ─── cleanup ────────────────────────────────────────────────────────────────────

async function cleanup() {
  if (ws && ws.readyState === WebSocket.OPEN && hasSession) {
    try {
      await bidiSend("session.end", {});
      log("[bidi-mcp] session ended cleanly");
    } catch {}
    ws.close();
  }
}

process.on("SIGINT", async () => { await cleanup(); process.exit(0); });
process.on("SIGTERM", async () => { await cleanup(); process.exit(0); });

// ─── bootstrap ──────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
log("[bidi-mcp] server running on stdio");
