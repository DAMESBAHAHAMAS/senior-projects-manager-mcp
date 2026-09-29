/**
 * Read-only Zoho WorkDrive client for the gateway.
 *
 * V1 boundary: this module performs GET requests only. It exposes no create,
 * update, move, rename, delete, share or permission operation, and it must
 * not gain one without a new authorization from the account owner.
 *
 * Credentials: uses WORKDRIVE_CLIENT_ID / WORKDRIVE_CLIENT_SECRET /
 * WORKDRIVE_REFRESH_TOKEN when set, otherwise falls back to the gateway's
 * ZOHO_* credentials. Whichever refresh token is used must carry the
 * read scopes WorkDrive.files.READ and WorkDrive.team.READ.
 */

import axios, { AxiosError } from "axios";

const TOKEN_URL = process.env.ZOHO_TOKEN_URL ?? "https://accounts.zoho.com/oauth/v2/token";
const API_BASE = process.env.WORKDRIVE_API_BASE ?? "https://www.zohoapis.com/workdrive/api/v1";
const DOWNLOAD_BASE =
  process.env.WORKDRIVE_DOWNLOAD_BASE ?? "https://download.zoho.com/v1/workdrive/download";

/** Largest file read_file will return as text (bytes). Larger files are refused, not truncated silently. */
const MAX_READ_BYTES = 1_000_000;
const PAGE_LIMIT = 50;
const MAX_PAGES = 20;
const TOKEN_SAFETY_MARGIN_MS = 60_000;

/** WorkDrive resource ids are lowercase alphanumeric. Rejecting anything else blocks path injection. */
const RESOURCE_ID = /^[a-z0-9]{10,64}$/i;

function env(name: string, fallback: string): string {
  const value = process.env[name] ?? process.env[fallback];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (or ${fallback})`);
  }
  return value;
}

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken;
  }
  const params = new URLSearchParams({
    client_id: env("WORKDRIVE_CLIENT_ID", "ZOHO_CLIENT_ID"),
    client_secret: env("WORKDRIVE_CLIENT_SECRET", "ZOHO_CLIENT_SECRET"),
    grant_type: "refresh_token",
    refresh_token: env("WORKDRIVE_REFRESH_TOKEN", "ZOHO_REFRESH_TOKEN"),
  });
  let response;
  try {
    response = await axios.post(TOKEN_URL, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15_000,
    });
  } catch (error) {
    throw new Error(`WorkDrive token refresh failed: ${describeError(error)}`);
  }
  const accessToken = response.data?.access_token;
  if (!accessToken) {
    // Never echo the payload: it can contain token material.
    throw new Error(`WorkDrive token refresh returned no access token (error: ${response.data?.error ?? "unknown"})`);
  }
  const expiresInMs = (Number(response.data.expires_in) || 3600) * 1000;
  cachedToken = { accessToken, expiresAt: Date.now() + expiresInMs - TOKEN_SAFETY_MARGIN_MS };
  return accessToken;
}

function describeError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const err = error as AxiosError<any>;
    if (err.response) {
      const data = err.response.data;
      const detail =
        data && typeof data === "object"
          ? JSON.stringify(data.errors ?? data.error ?? data).slice(0, 500)
          : String(data ?? "").slice(0, 500);
      return `HTTP ${err.response.status}: ${detail}`;
    }
    if (err.code === "ECONNABORTED") return "request timed out";
    return err.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function assertId(id: string, label: string): void {
  if (!RESOURCE_ID.test(id)) {
    throw new Error(`Invalid ${label}: expected a WorkDrive resource id (letters and digits only).`);
  }
}

export interface FolderItem {
  name: string;
  id: string;
  type: "folder" | "file";
  extension?: string;
}

/** List the direct children of a WorkDrive folder: name, id, type. No contents. */
export async function listFolder(folderId: string): Promise<FolderItem[]> {
  assertId(folderId, "folder_id");
  const token = await getAccessToken();
  const items: FolderItem[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    let response;
    try {
      response = await axios.get(`${API_BASE}/files/${folderId}/files`, {
        params: { "page[limit]": PAGE_LIMIT, "page[offset]": page * PAGE_LIMIT },
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          Accept: "application/vnd.api+json",
        },
        timeout: 30_000,
      });
    } catch (error) {
      throw new Error(`WorkDrive list_folder failed: ${describeError(error)}`);
    }
    const data: any[] = Array.isArray(response.data?.data) ? response.data.data : [];
    for (const entry of data) {
      const a = entry?.attributes ?? {};
      items.push({
        name: String(a.name ?? a.display_attr_name ?? ""),
        id: String(entry?.id ?? ""),
        type: a.is_folder ? "folder" : "file",
        ...(a.extn ? { extension: String(a.extn) } : {}),
      });
    }
    if (data.length < PAGE_LIMIT) break;
  }
  return items;
}

const TEXT_EXTENSIONS = new Set([
  "md", "txt", "csv", "tsv", "json", "yaml", "yml", "xml", "html", "htm", "log", "js", "ts", "py", "sql", "ini", "cfg",
]);

export interface ReadResult {
  id: string;
  name?: string;
  bytes: number;
  text: string;
}

async function fileMeta(fileId: string, token: string): Promise<{ name?: string; extension?: string; isFolder: boolean }> {
  try {
    const response = await axios.get(`${API_BASE}/files/${fileId}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}`, Accept: "application/vnd.api+json" },
      timeout: 30_000,
    });
    const a = response.data?.data?.attributes ?? {};
    return { name: a.name, extension: a.extn ? String(a.extn).toLowerCase() : undefined, isFolder: Boolean(a.is_folder) };
  } catch (error) {
    throw new Error(`WorkDrive read_file metadata lookup failed: ${describeError(error)}`);
  }
}

/** Download one file and return it as readable text. Refuses folders, binaries and oversized files. */
export async function readFile(fileId: string): Promise<ReadResult> {
  assertId(fileId, "file_id");
  const token = await getAccessToken();
  const meta = await fileMeta(fileId, token);
  if (meta.isFolder) {
    throw new Error("read_file was given a folder id. Use list_folder for folders.");
  }
  if (meta.extension && !TEXT_EXTENSIONS.has(meta.extension)) {
    throw new Error(
      `read_file V1 returns text files only; "${meta.name ?? fileId}" has extension .${meta.extension}.`
    );
  }
  let response;
  try {
    response = await axios.get(`${DOWNLOAD_BASE}/${fileId}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      responseType: "arraybuffer",
      maxContentLength: MAX_READ_BYTES,
      timeout: 60_000,
    });
  } catch (error) {
    throw new Error(`WorkDrive read_file download failed: ${describeError(error)}`);
  }
  const buffer = Buffer.from(response.data);
  return { id: fileId, name: meta.name, bytes: buffer.length, text: buffer.toString("utf8") };
}
