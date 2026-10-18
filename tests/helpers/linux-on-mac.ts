// Import FIRST in a suite that pins the Windows / Linux behaviour of the host OS — catalogs with no
// macOS entry, command lines without --use-mock-keychain, the /download/pro platform key, "managed"
// where an unlicensed Mac is "unavailable". On a Mac runner (CI's macos-latest) such a suite runs as
// Linux, so it keeps asserting what it was written for; the macOS behaviour has its own suites
// (tests/macos*.test.ts). Anywhere else this does nothing. The real platform comes back after the file.

import { afterAll } from "vitest";

const real = Object.getOwnPropertyDescriptor(process, "platform")!;

if (process.platform === "darwin") {
  Object.defineProperty(process, "platform", { ...real, value: "linux" });
  afterAll(() => {
    Object.defineProperty(process, "platform", real);
  });
}
