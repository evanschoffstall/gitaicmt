export interface ParsedConventionalSubject {
  description: string;
  isBreaking: boolean;
  scope: string;
  type: string;
}

/**
 * Normalizes a potential conventional-commit scope to a short, path-free,
 * hyphenated identifier that is safe across repositories.
 */
export function normalizeConventionalScope(scope: string): string {
  const trimmed = scope.trim().toLowerCase();
  if (trimmed.length === 0) {
    return "";
  }

  const isPathLike = /[\\/.]/u.test(trimmed);
  if (!isPathLike) {
    return sanitizeSubjectWords(trimmed).join("-");
  }

  const segments = trimmed
    .split(/[\\/.]+/u)
    .map((segment) => sanitizeSubjectWords(segment).join("-"))
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return "";
  }

  const tail = segments.at(-1) ?? "";
  const previous = segments.at(-2) ?? "";

  if (tail.length === 0) {
    return previous;
  }
  if (previous.length <= 3) {
    return tail;
  }

  return `${previous}-${tail}`;
}

/**
 * Returns a conventional subject line with a normalized, non-path scope.
 */
export function normalizeConventionalSubjectScope(subject: string): string {
  const parsed = parseSubjectWithPrefix(subject);
  if (!parsed || parsed.prefix.scope.length === 0) {
    return subject;
  }

  const normalizedScope = normalizeConventionalScope(parsed.prefix.scope);
  if (normalizedScope.length === 0 || normalizedScope === parsed.prefix.scope) {
    return subject;
  }

  const suffix = parsed.prefix.isBreaking ? "!" : "";
  return `${parsed.prefix.type}(${normalizedScope})${suffix}: ${parsed.description}`;
}

/** Parse the subject line shape consumed by the conventionalcommits preset. */
export function parseConventionalSubject(
  subject: string,
): ParsedConventionalSubject {
  const colonIdx = subject.indexOf(":");
  if (colonIdx <= 0 || colonIdx > 50) {
    return createPlainSubject(subject);
  }

  const parsedPrefix = parseSubjectPrefix(subject.slice(0, colonIdx));
  if (!parsedPrefix) {
    return createPlainSubject(subject);
  }

  const description = subject.slice(colonIdx + 1).trim();
  if (!parsedPrefix.scope) {
    return {
      description,
      isBreaking: parsedPrefix.isBreaking,
      scope: "",
      type: parsedPrefix.type,
    };
  }

  return {
    description,
    isBreaking: parsedPrefix.isBreaking,
    scope: parsedPrefix.scope,
    type: parsedPrefix.type,
  };
}

export function sanitizeSubjectWords(input: string): string[] {
  const words: string[] = [];
  let current = "";

  for (const char of input.toLowerCase()) {
    if ((char >= "a" && char <= "z") || (char >= "0" && char <= "9")) {
      current += char;
      continue;
    }

    if (current) {
      words.push(current);
      current = "";
    }
  }

  if (current) {
    words.push(current);
  }

  return words;
}

function createPlainSubject(subject: string): ParsedConventionalSubject {
  return { description: subject, isBreaking: false, scope: "", type: "" };
}

function isConventionalScope(value: string): boolean {
  return (
    value.trim().length > 0 && !value.includes("\n") && !value.includes("\r")
  );
}

function isConventionalType(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function parseRawSubjectPrefix(
  rawPrefix: string,
): null | Omit<ParsedConventionalSubject, "description"> {
  const isBreaking = rawPrefix.endsWith("!");
  const prefix = isBreaking ? rawPrefix.slice(0, -1) : rawPrefix;
  const openParen = prefix.indexOf("(");
  const closeParen = prefix.endsWith(")") ? prefix.lastIndexOf(")") : -1;

  if (openParen === -1) {
    return isConventionalType(prefix)
      ? { isBreaking, scope: "", type: prefix.toLowerCase() }
      : null;
  }

  const type = prefix.slice(0, openParen);
  const scope = prefix.slice(openParen + 1, closeParen).trim();
  if (
    closeParen !== prefix.length - 1 ||
    !isConventionalType(type) ||
    !isConventionalScope(scope)
  ) {
    return null;
  }

  return {
    isBreaking,
    scope,
    type: type.toLowerCase(),
  };
}

function parseSubjectPrefix(
  rawPrefix: string,
): null | Omit<ParsedConventionalSubject, "description"> {
  const parsed = parseRawSubjectPrefix(rawPrefix);
  if (!parsed) {
    return null;
  }

  const normalizedScope = normalizeConventionalScope(parsed.scope);
  if (parsed.scope.length > 0 && !isConventionalScope(normalizedScope)) {
    return null;
  }

  return {
    isBreaking: parsed.isBreaking,
    scope: normalizedScope,
    type: parsed.type,
  };
}

function parseSubjectWithPrefix(subject: string): null | {
  description: string;
  prefix: Omit<ParsedConventionalSubject, "description">;
} {
  const colonIdx = subject.indexOf(":");
  if (colonIdx <= 0 || colonIdx > 50) {
    return null;
  }

  const prefix = parseRawSubjectPrefix(subject.slice(0, colonIdx));
  if (!prefix) {
    return null;
  }

  return {
    description: subject.slice(colonIdx + 1).trim(),
    prefix,
  };
}
