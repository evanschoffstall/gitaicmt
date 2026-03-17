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
    return { description: subject, scope: "", type: "" };
  }

  const rawPrefix = subject.slice(0, colonIdx);
  const prefix = rawPrefix.endsWith("!") ? rawPrefix.slice(0, -1) : rawPrefix;
  const openParen = prefix.indexOf("(");
  const closeParen = prefix.endsWith(")") ? prefix.lastIndexOf(")") : -1;

  if (openParen === -1) {
    return isConventionalToken(prefix)
      ? {
          description: subject.slice(colonIdx + 1).trim(),
          scope: "",
          type: prefix.toLowerCase(),
        }
      : { description: subject, scope: "", type: "" };
  }

  if (
    closeParen !== prefix.length - 1 ||
    !isConventionalToken(prefix.slice(0, openParen))
  ) {
    return { description: subject, scope: "", type: "" };
  }

  return {
    description: subject.slice(colonIdx + 1).trim(),
    scope: prefix
      .slice(openParen + 1, closeParen)
      .trim()
      .toLowerCase(),
    type: prefix.slice(0, openParen).toLowerCase(),
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