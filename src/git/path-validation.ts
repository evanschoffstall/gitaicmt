import { MAX_PATH_LENGTH } from "../application/constants.js";
import { InvalidPathError } from "../application/errors.js";

const FORBIDDEN_PATH_CONTROL_CHARACTERS = /\p{Cc}/u;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[/\\]/u;

export function sanitizeFilePath(path: string): string {
  if (path.trim().length === 0) {
    throw new InvalidPathError(`Invalid file path is empty`, path);
  }
  if (FORBIDDEN_PATH_CONTROL_CHARACTERS.test(path)) {
    throw new InvalidPathError(
      `Invalid file path contains control characters`,
      path,
    );
  }
  if (path.startsWith("/") || WINDOWS_ABSOLUTE_PATH.test(path)) {
    throw new InvalidPathError(
      `Invalid file path (absolute path not allowed)`,
      path,
    );
  }
  if (path.startsWith("-")) {
    throw new InvalidPathError(`Invalid file path starts with dash`, path);
  }
  if (path.length > MAX_PATH_LENGTH) {
    throw new InvalidPathError(`File path exceeds maximum length`, path);
  }

  const normalized = normalizePath(path);
  if (normalized.length === 0) {
    throw new InvalidPathError(`Invalid file path is empty`, path);
  }
  if (normalized.startsWith("..")) {
    throw new InvalidPathError(`Path traversal attempt detected`, path);
  }

  return normalized;
}

function normalizePath(path: string): string {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  const resolved: string[] = [];

  for (const segment of segments) {
    if (segment === "..") {
      if (resolved.length === 0) {
        throw new InvalidPathError(
          `Path traversal attempt detected: ${path}`,
          path,
        );
      }
      resolved.pop();
      continue;
    }

    if (segment !== ".") {
      resolved.push(segment);
    }
  }

  return resolved.join("/");
}
