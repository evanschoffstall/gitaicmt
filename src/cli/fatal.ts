const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export function die(message: string): never {
  process.stderr.write(`${RED}error:${RESET} ${message}\n`);
  process.exit(1);
}