// electron-builder afterPack hook: give the macOS app an ad-hoc signature.
//
// The release is not signed with an Apple Developer ID (that needs a paid certificate; the
// provenance attestation and checksums are the integrity proof, as on Windows). Left alone, the
// bundle still carries Electron's own signature, whose seal no longer matches once electron-builder
// has rewritten Info.plist and added the app: macOS then calls the download "damaged" and offers no
// way past it. An ad-hoc signature seals the bundle as built, so Gatekeeper treats it as an app from
// an unidentified developer instead — blocked on first open, then allowed from System Settings →
// Privacy & Security → Open Anyway. Apple Silicon also refuses to run code with no valid signature.
//
// Runs for every platform's package; only the macOS one is touched.

const { execFileSync } = require("node:child_process");
const path = require("node:path");

/** Sign `context`'s app when it is a macOS build. `run` is the child-process seam for tests. */
function adhocSign(context, run = execFileSync) {
  if (context.electronPlatformName !== "darwin") return null;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  run("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  // Fail the build here rather than ship a bundle macOS will reject.
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" });
  return app;
}

exports.adhocSign = adhocSign;
exports.default = async function afterPack(context) {
  adhocSign(context);
};
