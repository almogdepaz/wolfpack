export const NAMED_VIEW_SCHEMA_VERSION = 1;
export const MIN_NAMED_VIEW_MEMBERS = 1;
export const MAX_NAMED_VIEW_MEMBERS = 6;
export const MAX_NAMED_VIEWS = 100;
export const MAX_NAMED_VIEW_NAME_CODE_POINTS = 64;
export const MAX_NAMED_VIEW_ID_LENGTH = 80;
export const MAX_NAMED_VIEW_SESSION_ID_LENGTH = 128;
export const MAX_NAMED_VIEW_SESSION_NAME_CODE_POINTS = 100;
export const MAX_NAMED_VIEW_MACHINE_URL_LENGTH = 256;

const NAMED_VIEW_INPUT_KEYS = new Set(["name", "members", "focused"]);
const NAMED_VIEW_MEMBER_KEYS = new Set(["machineUrl", "sessionId", "sessionName"]);
const NAMED_VIEW_FOCUS_KEYS = new Set(["machineUrl", "sessionId"]);
const NAMED_VIEW_RECORD_KEYS = new Set([
  "schemaVersion",
  "id",
  "name",
  "members",
  "focused",
  "createdAt",
  "updatedAt",
]);
const NAMED_VIEW_FILE_KEYS = new Set(["schemaVersion", "views"]);
const CONTROL_CHARACTERS = /[\p{Cc}]/u;
const NAMED_VIEW_ID = /^[A-Za-z0-9_-][A-Za-z0-9_-]{0,79}$/;

export interface NamedViewMemberReference {
  readonly machineUrl: string;
  readonly sessionId: string;
  readonly sessionName: string;
}

export interface NamedViewFocusReference {
  readonly machineUrl: string;
  readonly sessionId: string;
}

export interface NamedViewInput {
  readonly name: string;
  readonly members: readonly NamedViewMemberReference[];
  readonly focused?: NamedViewFocusReference;
}

export interface NamedViewRecord extends NamedViewInput {
  readonly schemaVersion: typeof NAMED_VIEW_SCHEMA_VERSION;
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NamedViewStoreFile {
  readonly schemaVersion: typeof NAMED_VIEW_SCHEMA_VERSION;
  readonly views: readonly NamedViewRecord[];
}

export type NamedViewParseResult<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: string };

export const NAMED_VIEW_INVALID_REQUEST = "invalid named-view request";

export function parseNamedViewInput(value: unknown): NamedViewParseResult<NamedViewInput> {
  if (!isJsonObject(value) || !hasOnlyKeys(value, NAMED_VIEW_INPUT_KEYS)) return invalidNamedViewInput();
  if (typeof value.name !== "string" || !Array.isArray(value.members)) return invalidNamedViewInput();

  const name = normalizeNamedViewName(value.name);
  if (!name) return invalidNamedViewInput();
  const members = parseMembers(value.members);
  if (!members) return invalidNamedViewInput();

  let focused: NamedViewFocusReference | undefined;
  if (value.focused !== undefined) {
    const parsedFocus = parseFocus(value.focused);
    if (!parsedFocus || !members.some((member) => sameMachineSession(member, parsedFocus))) return invalidNamedViewInput();
    focused = parsedFocus;
  }

  return {
    ok: true,
    value: {
      name,
      members,
      ...(focused ? { focused } : {}),
    },
  };
}

export function parseStoredNamedViewFile(value: unknown): NamedViewParseResult<NamedViewStoreFile> {
  if (!isJsonObject(value) || !hasOnlyKeys(value, NAMED_VIEW_FILE_KEYS)) return invalidNamedViewInput();
  if (value.schemaVersion !== NAMED_VIEW_SCHEMA_VERSION || !Array.isArray(value.views)) return invalidNamedViewInput();
  if (value.views.length > MAX_NAMED_VIEWS) return invalidNamedViewInput();

  const views: NamedViewRecord[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const candidate of value.views) {
    const view = parseStoredNamedViewRecord(candidate);
    if (!view) return invalidNamedViewInput();
    const nameKey = namedViewNameKey(view.name);
    if (names.has(nameKey) || ids.has(view.id)) return invalidNamedViewInput();
    names.add(nameKey);
    ids.add(view.id);
    views.push(view);
  }
  return { ok: true, value: { schemaVersion: NAMED_VIEW_SCHEMA_VERSION, views } };
}

export function isStoredNamedViewFile(value: unknown): value is NamedViewStoreFile {
  return parseStoredNamedViewFile(value).ok;
}

export function normalizeNamedViewName(value: string): string | null {
  const name = value.trim();
  if (name.length === 0 || CONTROL_CHARACTERS.test(name)) return null;
  if (Array.from(name).length > MAX_NAMED_VIEW_NAME_CODE_POINTS) return null;
  return name;
}

export function namedViewNameKey(name: string): string {
  return name.toLocaleLowerCase();
}

export function isValidNamedViewId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_NAMED_VIEW_ID_LENGTH
    && !CONTROL_CHARACTERS.test(value)
    && NAMED_VIEW_ID.test(value);
}

export function isValidNamedViewMachineUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === "") return true;
  if (value.length > MAX_NAMED_VIEW_MACHINE_URL_LENGTH || CONTROL_CHARACTERS.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.username === ""
      && url.password === ""
      && url.hostname.length > 0
      && url.hostname.toLocaleLowerCase().endsWith(".ts.net")
      && (url.pathname === "" || url.pathname === "/")
      && url.search === ""
      && url.hash === ""
      && value === url.origin;
  } catch {
    return false;
  }
}

function parseStoredNamedViewRecord(value: unknown): NamedViewRecord | null {
  if (!isJsonObject(value) || !hasOnlyKeys(value, NAMED_VIEW_RECORD_KEYS)) return null;
  if (value.schemaVersion !== NAMED_VIEW_SCHEMA_VERSION || !isValidNamedViewId(value.id)) return null;
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return null;
  if (!isIsoDateString(value.createdAt) || !isIsoDateString(value.updatedAt)) return null;
  const parsed = parseNamedViewInput({
    name: value.name,
    members: value.members,
    ...(value.focused !== undefined ? { focused: value.focused } : {}),
  });
  if (!parsed.ok) return null;
  return {
    schemaVersion: NAMED_VIEW_SCHEMA_VERSION,
    id: value.id,
    ...parsed.value,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseMembers(value: readonly unknown[]): readonly NamedViewMemberReference[] | null {
  if (value.length < MIN_NAMED_VIEW_MEMBERS || value.length > MAX_NAMED_VIEW_MEMBERS) return null;
  const members: NamedViewMemberReference[] = [];
  const keys = new Set<string>();
  for (const candidate of value) {
    const member = parseMember(candidate);
    if (!member) return null;
    const key = machineSessionKey(member);
    if (keys.has(key)) return null;
    keys.add(key);
    members.push(member);
  }
  return members;
}

function parseMember(value: unknown): NamedViewMemberReference | null {
  if (!isJsonObject(value) || !hasOnlyKeys(value, NAMED_VIEW_MEMBER_KEYS)) return null;
  if (
    !isValidNamedViewMachineUrl(value.machineUrl)
    || !isBoundedText(value.sessionId, MAX_NAMED_VIEW_SESSION_ID_LENGTH)
    || !isBoundedCodePointText(value.sessionName, MAX_NAMED_VIEW_SESSION_NAME_CODE_POINTS)
  ) {
    return null;
  }
  return {
    machineUrl: value.machineUrl,
    sessionId: value.sessionId,
    sessionName: value.sessionName,
  };
}

function parseFocus(value: unknown): NamedViewFocusReference | undefined {
  if (!isJsonObject(value) || !hasOnlyKeys(value, NAMED_VIEW_FOCUS_KEYS)) return undefined;
  if (!isValidNamedViewMachineUrl(value.machineUrl) || !isBoundedText(value.sessionId, MAX_NAMED_VIEW_SESSION_ID_LENGTH)) {
    return undefined;
  }
  return { machineUrl: value.machineUrl, sessionId: value.sessionId };
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value
    && !CONTROL_CHARACTERS.test(value);
}

function isBoundedCodePointText(value: unknown, maxCodePoints: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && !CONTROL_CHARACTERS.test(value)
    && Array.from(value).length <= maxCodePoints;
}

function isIsoDateString(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function machineSessionKey(value: NamedViewFocusReference): string {
  return `${value.machineUrl}\0${value.sessionId}`;
}

function sameMachineSession(left: NamedViewFocusReference, right: NamedViewFocusReference): boolean {
  return machineSessionKey(left) === machineSessionKey(right);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function invalidNamedViewInput<TValue>(): NamedViewParseResult<TValue> {
  return { ok: false, error: NAMED_VIEW_INVALID_REQUEST };
}
