/**
 * Remote file operations (`wolfpack file`): routes, limits and error codes shared
 * by the server, the CLI and the control API schema. Access is any path the
 * server user can access, behind the ordinary global API auth gate.
 */

export const REMOTE_FILE_ROUTE = {
  READ: "/api/file/read",
  WRITE: "/api/file/write",
  EDIT: "/api/file/edit",
} as const;

/** Largest file read, written or produced by an edit. */
export const REMOTE_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Room for the JSON envelope around file content in a request body. */
const BODY_ENVELOPE_BYTES = 64 * 1024;

/** A write body: base64 content of the largest file plus the envelope. */
export const REMOTE_FILE_WRITE_BODY_MAX_BYTES = Math.ceil(REMOTE_FILE_MAX_BYTES / 3) * 4 + BODY_ENVELOPE_BYTES;

/** An edit body: old and new text, each up to the largest file, plus the envelope. */
export const REMOTE_FILE_EDIT_BODY_MAX_BYTES = REMOTE_FILE_MAX_BYTES * 2 + BODY_ENVELOPE_BYTES;

/** Longest accepted path. */
export const REMOTE_FILE_MAX_PATH_LENGTH = 4096;

export const REMOTE_FILE_ENCODING = {
  UTF8: "utf8",
  BASE64: "base64",
} as const;
export type RemoteFileEncoding = typeof REMOTE_FILE_ENCODING[keyof typeof REMOTE_FILE_ENCODING];
export const REMOTE_FILE_ENCODINGS = Object.values(REMOTE_FILE_ENCODING);

export const REMOTE_FILE_ERROR = {
  INVALID_REQUEST: "INVALID_REQUEST",
  REQUEST_TOO_LARGE: "REQUEST_TOO_LARGE",
  PATH_NOT_ABSOLUTE: "PATH_NOT_ABSOLUTE",
  NOT_FOUND: "NOT_FOUND",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  NOT_A_FILE: "NOT_A_FILE",
  SYMLINK_LOOP: "SYMLINK_LOOP",
  DANGLING_SYMLINK: "DANGLING_SYMLINK",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  FILE_EXISTS: "FILE_EXISTS",
  BINARY_FILE: "BINARY_FILE",
  EDIT_MATCH_COUNT: "EDIT_MATCH_COUNT",
  IO_FAILED: "IO_FAILED",
} as const;
export type RemoteFileErrorCode = typeof REMOTE_FILE_ERROR[keyof typeof REMOTE_FILE_ERROR];
export const REMOTE_FILE_ERRORS = Object.values(REMOTE_FILE_ERROR);

export const REMOTE_FILE_ERROR_STATUS: Readonly<Record<RemoteFileErrorCode, number>> = {
  INVALID_REQUEST: 400,
  REQUEST_TOO_LARGE: 413,
  PATH_NOT_ABSOLUTE: 400,
  NOT_FOUND: 404,
  PERMISSION_DENIED: 403,
  NOT_A_FILE: 409,
  SYMLINK_LOOP: 409,
  DANGLING_SYMLINK: 409,
  FILE_TOO_LARGE: 413,
  FILE_EXISTS: 409,
  BINARY_FILE: 409,
  EDIT_MATCH_COUNT: 409,
  IO_FAILED: 500,
};

export interface RemoteFileRead {
  readonly ok: true;
  readonly path: string;
  readonly resolvedPath: string;
  readonly size: number;
  readonly binary: boolean;
  readonly encoding: RemoteFileEncoding;
  readonly content: string;
}

export interface RemoteFileWrite {
  readonly ok: true;
  readonly path: string;
  readonly resolvedPath: string;
  readonly size: number;
  readonly created: boolean;
}

export interface RemoteFileEdit {
  readonly ok: true;
  readonly path: string;
  readonly resolvedPath: string;
  readonly size: number;
  readonly replacements: number;
}

/** Error envelope: `error` is the message; details (`size`, `maxBytes`, `matches`) sit beside it. */
export interface RemoteFileFailure {
  readonly error: string;
  readonly code: RemoteFileErrorCode;
  readonly size?: number;
  readonly maxBytes?: number;
  readonly matches?: number;
}
