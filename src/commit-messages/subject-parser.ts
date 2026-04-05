export interface ParsedConventionalSubject {
  description: string;
  scope: string;
  type: string;
}

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
      scope: "",
      type: parsedPrefix.type,
    };
  }

  return {
    description,
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
  return { description: subject, scope: "", type: "" };
}

function isConventionalToken(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  for (const char of value) {
    const isAlpha =
      (char >= "a" && char <= "z") || (char >= "A" && char <= "Z");
    const isDigit = char >= "0" && char <= "9";
    if (!isAlpha && !isDigit && char !== "_") {
      return false;
    }
  }

  return true;
}

function parseSubjectPrefix(
  rawPrefix: string,
): null | Omit<ParsedConventionalSubject, "description"> {
  const prefix = rawPrefix;
  const openParen = prefix.indexOf("(");
  const closeParen = prefix.endsWith(")") ? prefix.lastIndexOf(")") : -1;

  if (openParen === -1) {
    return isConventionalToken(prefix)
      ? { scope: "", type: prefix.toLowerCase() }
      : null;
  }

  if (
    closeParen !== prefix.length - 1 ||
    !isConventionalToken(prefix.slice(0, openParen))
  ) {
    return null;
  }

  return {
    scope: prefix
      .slice(openParen + 1, closeParen)
      .trim()
      .toLowerCase(),
    type: prefix.slice(0, openParen).toLowerCase(),
  };
}