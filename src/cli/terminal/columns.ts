interface ResolveTerminalColumnsOptions {
  environment?: NodeJS.ProcessEnv;
  fallbackColumns: number;
  streams?: readonly TerminalSizeStream[];
}

interface TerminalSizeStream {
  columns?: number;
  getWindowSize?: () => [number, number];
}

export function resolveTerminalColumns(
  options: ResolveTerminalColumnsOptions,
): number {
  const streamColumns = resolveStreamColumns(options.streams ?? []);
  if (streamColumns !== null) {
    return streamColumns;
  }

  const envColumns = resolveEnvironmentColumns(options.environment ?? process.env);
  if (envColumns !== null) {
    return envColumns;
  }

  return options.fallbackColumns;
}

function resolveEnvironmentColumns(
  environment: NodeJS.ProcessEnv,
): null | number {
  const rawColumns = environment.COLUMNS;
  if (typeof rawColumns !== "string" || rawColumns.trim().length === 0) {
    return null;
  }

  const parsedColumns = Number.parseInt(rawColumns, 10);
  return Number.isFinite(parsedColumns) && parsedColumns > 0
    ? parsedColumns
    : null;
}

function resolveStreamColumns(
  streams: readonly TerminalSizeStream[],
): null | number {
  for (const stream of streams) {
    if (
      typeof stream.columns === "number" &&
      Number.isFinite(stream.columns) &&
      stream.columns > 0
    ) {
      return stream.columns;
    }

    const windowSizeColumns = resolveWindowSizeColumns(stream);
    if (windowSizeColumns !== null) {
      return windowSizeColumns;
    }
  }

  return null;
}

function resolveWindowSizeColumns(
  stream: TerminalSizeStream,
): null | number {
  if (typeof stream.getWindowSize !== "function") {
    return null;
  }

  try {
    const [columns] = stream.getWindowSize();
    return Number.isFinite(columns) && columns > 0 ? columns : null;
  } catch {
    return null;
  }
}