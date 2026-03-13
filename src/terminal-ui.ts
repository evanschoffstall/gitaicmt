const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const CLEAR_LINE = "\r\x1b[2K";

export const THINKING_GLYPHS = [
  "✧",
  "✦",
  "✷",
  "✹",
  "✺",
  "✸",
  "✴",
  "✳",
] as const;

export const THINKING_MESSAGES = [
  "Thinking",
  "Pondering",
  "Considering",
  "Calculating",
  "Analyzing",
  "Reasoning",
  "Reflecting",
  "Exploring",
  "Inspecting",
  "Examining",
  "Tracing",
  "Mapping",
  "Sorting",
  "Scanning",
  "Checking",
  "Comparing",
  "Synthesizing",
  "Refining",
  "Drafting",
  "Composing",
  "Polishing",
  "Untangling",
  "Reconstructing",
  "Connecting",
  "Reframing",
  "Balancing",
  "Testing",
  "Validating",
  "Verifying",
  "Aligning",
  "Focusing",
  "Clarifying",
  "Condensing",
  "Expanding",
  "Distilling",
  "Interesting",
  "Intriguing",
  "Noticing",
  "Observing",
  "Spotting",
  "Gathering",
  "Collecting",
  "Shuffling",
  "Juggling",
  "Weaving",
  "Stitching",
  "Untying",
  "Twisting",
  "Tuning",
  "Adjusting",
  "Calibrating",
  "Balancing",
  "Aligning",
  "Warming",
  "Loading",
  "Spinning",
  "Brewing",
  "Cooking",
  "Conjuring",
] as const;

const GRADIENT_STOPS = [
  [145, 54, 34],
  [191, 87, 44],
  [224, 128, 53],
  [242, 172, 74],
  [250, 212, 124],
  [255, 255, 255],
  [244, 196, 146],
  [228, 150, 108],
  [198, 102, 84],
] as const;

const TEXT_GRADIENT_STOPS = [
  [124, 124, 128],
  [150, 150, 156],
  [176, 176, 184],
  [202, 202, 210],
  [228, 228, 234],
  [246, 246, 248],
  [255, 255, 255],
  [238, 238, 242],
  [212, 212, 220],
] as const;

const GLYPH_HOLD_FRAMES = 10;
const GLYPH_COLOR_HOLD_FRAMES = 3;
const MAX_MESSAGE_HOLD_FRAMES = 40;
const MIN_MESSAGE_HOLD_FRAMES = 24;
const GLYPH_COLUMN_WIDTH = 2;
const MESSAGE_COLUMN_WIDTH =
  Math.max(...THINKING_MESSAGES.map((message) => message.length)) + 3;

export interface ThinkingIndicatorOptions {
  enabled?: boolean;
  frameIntervalMs?: number;
  output?: TerminalWriter;
}

interface TerminalWriter {
  isTTY?: boolean;
  write(chunk: string): boolean;
}

export function renderThinkingFrame(frameIndex: number): string {
  const glyph =
    THINKING_GLYPHS[
      Math.floor(frameIndex / GLYPH_HOLD_FRAMES) % THINKING_GLYPHS.length
    ];
  const message = resolveMessageForFrame(frameIndex);
  const glyphPhase =
    Math.floor(frameIndex / GLYPH_COLOR_HOLD_FRAMES) % GRADIENT_STOPS.length;
  const textPhase = frameIndex % TEXT_GRADIENT_STOPS.length;
  const glyphColumn = glyph.padEnd(GLYPH_COLUMN_WIDTH, " ");
  const messageColumn = `${message}...`.padEnd(MESSAGE_COLUMN_WIDTH, " ");

  return [
    CLEAR_LINE,
    colorizeText(glyphColumn, glyphPhase, GRADIENT_STOPS, true),
    " ",
    colorizeText(
      messageColumn,
      textPhase + GLYPH_COLUMN_WIDTH,
      TEXT_GRADIENT_STOPS,
      true,
    ),
    RESET,
  ].join("");
}

export function shouldAnimateThinkingIndicator(
  output: TerminalWriter = process.stderr,
): boolean {
  return (
    output.isTTY === true &&
    process.env.CI !== "true" &&
    process.env.TERM !== "dumb"
  );
}

export async function withThinkingIndicator<T>(
  task: () => Promise<T>,
  options?: ThinkingIndicatorOptions,
): Promise<T> {
  const output = options?.output ?? process.stderr;
  const isEnabled = options?.enabled ?? shouldAnimateThinkingIndicator(output);
  if (!isEnabled) {
    return task();
  }

  const frameIntervalMs = options?.frameIntervalMs ?? 110;
  let frameIndex = 0;

  const renderFrame = () => {
    output.write(renderThinkingFrame(frameIndex));
    frameIndex++;
  };

  renderFrame();
  const intervalId = setInterval(renderFrame, frameIntervalMs);

  try {
    return await task();
  } finally {
    clearInterval(intervalId);
    output.write(CLEAR_LINE);
  }
}

function colorizeText(
  text: string,
  phase: number,
  gradientStops: readonly (readonly [number, number, number])[],
  bold = false,
): string {
  return Array.from(text)
    .map((char, index) => {
      const [red, green, blue] =
        gradientStops[
          (phase - index + gradientStops.length * 8) % gradientStops.length
        ];
      const weight = bold ? BOLD : "";
      return `${weight}\x1b[38;2;${String(red)};${String(green)};${String(blue)}m${char}`;
    })
    .join("");
}

function getMessageHoldFrames(slotIndex: number): number {
  const spread = MAX_MESSAGE_HOLD_FRAMES - MIN_MESSAGE_HOLD_FRAMES + 1;
  return MIN_MESSAGE_HOLD_FRAMES + ((slotIndex * 11 + 7) % spread);
}

function getMessageIndexForSlot(slotIndex: number): number {
  return (slotIndex * 17 + 13) % THINKING_MESSAGES.length;
}

function resolveMessageForFrame(frameIndex: number): string {
  const cycleLength = THINKING_MESSAGES.reduce(
    (sum, _, slotIndex) => sum + getMessageHoldFrames(slotIndex),
    0,
  );
  let remainingFrames = frameIndex % cycleLength;

  for (let slotIndex = 0; slotIndex < THINKING_MESSAGES.length; slotIndex++) {
    const holdFrames = getMessageHoldFrames(slotIndex);
    if (remainingFrames < holdFrames) {
      return THINKING_MESSAGES[getMessageIndexForSlot(slotIndex)];
    }
    remainingFrames -= holdFrames;
  }

  return THINKING_MESSAGES[getMessageIndexForSlot(0)];
}
