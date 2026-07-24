export function evaluateSigningGate(platform, environment = process.env) {
  const approval = environment.SELENE_SIGNING_APPROVED === 'true';
  const requirements = {
    macos: ['CSC_LINK', 'APPLE_API_KEY_CONTENT', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
    windows: ['CSC_LINK', 'CSC_KEY_PASSWORD']
  };

  if (!requirements[platform]) {
    return { enabled: false, reason: `No signing hook is configured for ${platform}; skipping.` };
  }

  const missing = requirements[platform].filter((name) => !environment[name]);
  if (!approval || missing.length > 0) {
    return {
      enabled: false,
      reason: `Skipping ${platform} signing: protected approval ${approval ? 'is present' : 'is absent'}; missing=${missing.join(',') || 'none'}.`
    };
  }

  return {
    enabled: true,
    reason: `Protected ${platform} signing and notarization credentials were approved.`
  };
}

if (import.meta.main) {
  const platform = process.argv[process.argv.indexOf('--platform') + 1];
  const result = evaluateSigningGate(platform);
  console.log(`enabled=${result.enabled}`);
  console.log(result.reason);
}
