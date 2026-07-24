/**
 * electron-builder calls this only from the protected signing workflow after
 * its environment gate has approved a macOS signing/notarization run.
 */
export default async function notarizeDesktop(context) {
  if (process.env.SELENE_SIGNING_APPROVED !== 'true') {
    console.log('Skipping notarization: protected signing approval is absent.');
    return;
  }
  if (
    !process.env.APPLE_API_KEY ||
    !process.env.APPLE_API_KEY_ID ||
    !process.env.APPLE_API_ISSUER
  ) {
    throw new Error('Protected macOS signing run is missing App Store Connect API credentials.');
  }

  const { notarize } = await import('@electron/notarize');
  await notarize({
    appPath: `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`,
    tool: 'notarytool',
    appleApiKey: process.env.APPLE_API_KEY,
    appleApiKeyId: process.env.APPLE_API_KEY_ID,
    appleApiIssuer: process.env.APPLE_API_ISSUER
  });
}
