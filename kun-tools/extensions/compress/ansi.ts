import type { LineReducer } from "./types.js";

// CSI / SGR sequences, OSC sequences, and lone control chars (except tab).
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]|\u001b[PX^_].*?\u001b\\|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
// eslint-disable-next-line no-control-regex
const BARE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function stripAnsi(line: string): string {
  return line.replace(ANSI_PATTERN, "").replace(BARE_CONTROL, "");
}

/** Stage 1: strip ANSI escape sequences and bare control characters. */
export class AnsiReducer implements LineReducer {
  readonly name = "ansi";
  hits = 0;

  push(line: string): string[] {
    const stripped = stripAnsi(line);
    if (stripped !== line) this.hits += 1;
    return [stripped];
  }

  flush(): string[] {
    return [];
  }
}
