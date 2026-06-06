/** Extracts textual content from a Responses API payload. */
export function extractResponseText(raw: unknown): string {
  const asObj = raw as {
    output?: {
      content?: { text?: string; type?: string }[];
    }[];
    output_text?: string;
  };

  if (typeof asObj.output_text === "string" && asObj.output_text.trim()) {
    return asObj.output_text.trim();
  }

  const parts: string[] = [];
  for (const item of asObj.output ?? []) {
    for (const content of item.content ?? []) {
      if (isResponseTextContent(content)) {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n").trim();
}

function isResponseTextContent(content: {
  text?: string;
  type?: string;
}): content is { text: string; type?: string } {
  return (
    (content.type === "output_text" || content.type === "text") &&
    typeof content.text === "string"
  );
}
