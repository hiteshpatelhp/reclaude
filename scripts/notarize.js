// electron-builder afterSign hook. On macOS, notarizes the .app bundle via
// @electron/notarize when credentials are present. On Windows, verifies the
// signed binary via signtool when the build was code-signed. Both checks
// fail loudly (non-zero exit) on misconfiguration so a CI pipeline cannot
// silently produce an unsigned / unnotarized release.
//
// Required env vars for a notarized macOS release:
//   APPLE_ID                     Apple ID email
//   APPLE_APP_SPECIFIC_PASSWORD  App-specific password
//   APPLE_TEAM_ID                Developer Team ID
//
// Required env vars for a code-signed Windows release:
//   CSC_LINK                     Path to .pfx (electron-builder convention)
//
// Opt-out env vars:
//   SKIP_NOTARIZATION=1          Force-skip macOS notarize (e.g. ad-hoc dev DMG)
//   SKIP_CODESIGN=1              Force-skip Windows signing verification

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

exports.default = async function afterSign(context) {
  if (context.electronPlatformName === 'darwin') {
    return notarizeMac(context);
  }
  if (context.electronPlatformName === 'win32') {
    return verifyWindowsSigning(context);
  }
};

async function notarizeMac(context) {
  if (process.env.SKIP_NOTARIZATION === '1') {
    console.log('[notarize] SKIP_NOTARIZATION=1 — skipping macOS notarization');
    return;
  }

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    // Dev / unsigned distribution path. Loud warning so CI runs are
    // observable. Caller must set SKIP_NOTARIZATION=1 to silence.
    console.warn(
      '[notarize] APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set — ' +
        'skipping macOS notarization. The resulting .app will be unsigned and ' +
        'rejected by Gatekeeper. Set SKIP_NOTARIZATION=1 to silence this warning.',
    );
    return;
  }

  // Lazy-require so unsigned dev builds don't need @electron/notarize at all.
  // Wrap in try/catch with a non-zero exit so a CI run with `npm ci --omit=dev`
  // (which excludes @electron/notarize from devDependencies) fails the build
  // explicitly instead of silently skipping notarization.
  let notarizeModule;
  try {
    notarizeModule = require('@electron/notarize');
  } catch (e) {
    console.error(
      '[notarize] FATAL: @electron/notarize is not installed but APPLE_ID is set. ' +
        'This usually means CI used `npm ci --omit=dev`. Either install dev ' +
        'dependencies for the build, or set SKIP_NOTARIZATION=1 to opt out.',
    );
    process.exit(1);
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log('[notarize] notarizing', appPath, 'for team', APPLE_TEAM_ID);
  await notarizeModule.notarize({
    tool: 'notarytool',
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
  console.log('[notarize] done');
}

function verifyWindowsSigning(context) {
  if (process.env.SKIP_CODESIGN === '1') {
    console.log('[afterSign:win] SKIP_CODESIGN=1 — skipping signature verification');
    return;
  }
  if (!process.env.CSC_LINK) {
    // Loud warning — unsigned Windows installer triggers SmartScreen and
    // is frequently blocked in enterprise environments. Caller must opt
    // out with SKIP_CODESIGN=1.
    console.warn(
      '[afterSign:win] CSC_LINK not set — Windows installer will be unsigned. ' +
        'SmartScreen will warn end users on launch. Set SKIP_CODESIGN=1 to silence ' +
        'this warning.',
    );
    return;
  }

  // Walk the appOutDir and verify any .exe outputs via signtool. signtool
  // is part of the Windows SDK and should already be on the build host's
  // PATH for a signing-capable CI environment. We don't pin to an absolute
  // path because the SDK install location varies by version.
  const outDir = context.appOutDir;
  const candidates = fs
    .readdirSync(outDir)
    .filter((f) => f.toLowerCase().endsWith('.exe'))
    .map((f) => path.join(outDir, f));
  if (candidates.length === 0) {
    console.warn('[afterSign:win] no .exe found in', outDir, '— nothing to verify');
    return;
  }
  for (const exe of candidates) {
    const r = spawnSync('signtool', ['verify', '/pa', '/v', exe], { encoding: 'utf8' });
    if (r.error || r.status !== 0) {
      console.error(
        '[afterSign:win] FATAL: signtool verify failed for',
        exe,
        '\n' + (r.stderr || r.stdout || r.error?.message || ''),
      );
      process.exit(1);
    }
    console.log('[afterSign:win] verified', exe);
  }
}
