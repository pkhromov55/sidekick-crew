// Files in and out of the chat.
// In:  Telegram attachment -> Anthropic Files API -> content block for the agent.
// Out: file the sandbox produced -> download -> Telegram document.
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import type { Bot } from "grammy";
import { getBot } from "./bots";
import { env } from "./env";

const client = new Anthropic();

// Referencing an uploaded file_id from the Messages API needs this beta.
export const FILES_BETA = "files-api-2025-04-14";

const PDF = "application/pdf";
const MIME_BY_EXT: Record<string, string> = {
  pdf: PDF,
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  yaml: "text/yaml",
  yml: "text/yaml",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

// Bots can only download files up to 20 MB through the Bot API.
const TG_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

export type Attachment = { fileId: string; fileName: string; mime: string };

export function guessMime(fileName: string, fallback = "application/octet-stream"): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? fallback;
}

export async function downloadTelegramFile(botId: string, bot: Bot, tgFileId: string, preferredName?: string) {
  const file = await bot.api.getFile(tgFileId);
  if (!file.file_path) throw new Error("telegram file has no path");
  if ((file.file_size ?? 0) > TG_DOWNLOAD_LIMIT) throw new Error("file is larger than 20 MB");
  const token = env(getBot(botId).tokenEnv);
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!res.ok) throw new Error(`telegram download failed: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const fileName = preferredName ?? file.file_path.split("/").pop() ?? "file";
  return { bytes, fileName, mime: guessMime(fileName) };
}

export async function uploadAttachment(bytes: Buffer, fileName: string, mime: string): Promise<Attachment> {
  const meta = await client.beta.files.upload({
    file: await toFile(bytes, fileName, { type: mime }),
    betas: [FILES_BETA],
  });
  return { fileId: meta.id, fileName: meta.filename ?? fileName, mime: meta.mime_type ?? mime };
}

// PDFs and images go to the model directly; anything else is read in the sandbox.
export function attachmentBlock(a: Attachment): Anthropic.Beta.BetaContentBlockParam {
  if (a.mime === PDF) {
    return { type: "document", source: { type: "file", file_id: a.fileId }, title: a.fileName };
  }
  if (a.mime.startsWith("image/")) {
    return { type: "image", source: { type: "file", file_id: a.fileId } };
  }
  return { type: "container_upload", file_id: a.fileId };
}

// Files the sandbox wrote arrive as *_code_execution_output blocks nested in tool results.
export function collectGeneratedFileIds(content: unknown): string[] {
  const ids: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (typeof obj.type === "string" && obj.type.endsWith("_code_execution_output") && typeof obj.file_id === "string") {
      ids.push(obj.file_id);
    }
    Object.values(obj).forEach(walk);
  };
  walk(content);
  return [...new Set(ids)];
}

export async function fetchAnthropicFile(fileId: string) {
  const meta = await client.beta.files.retrieveMetadata(fileId, { betas: [FILES_BETA] });
  const res = await client.beta.files.download(fileId, { betas: [FILES_BETA] });
  const bytes = Buffer.from(await res.arrayBuffer());
  const fileName = meta.filename ?? "file";
  return { bytes, fileName, mime: meta.mime_type ?? guessMime(fileName) };
}
