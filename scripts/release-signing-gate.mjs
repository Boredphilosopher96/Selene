const platform = process.argv[process.argv.indexOf('--platform') + 1];
const approval = process.env.SELENE_SIGNING_APPROVED === 'true';
const requirements = {
  macos: ['CSC_LINK', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
  windows: ['CSC_LINK', 'CSC_KEY_PASSWORD']
};

if (!requirements[platform]) {
  console.log('enabled=false');
  console.log(`No signing hook is configured for ${platform}; skipping.`);
  process.exit(0);
}

const missing = requirements[platform].filter((name) => !process.env[name]);
if (!approval || missing.length > 0) {
  console.log('enabled=false');
  console.log(
    `Skipping ${platform} signing: protected approval ${approval ? 'is present' : 'is absent'}; missing=${missing.join(',') || 'none'}.`
  );
  process.exit(0);
}

console.log('enabled=true');
console.log(`Protected ${platform} signing and notarization credentials were approved.`);
