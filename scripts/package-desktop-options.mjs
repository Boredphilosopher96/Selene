const platformFromHost = { darwin: 'macos', linux: 'linux', win32: 'windows' };

const optionValue = (arguments_, name) => {
  const index = arguments_.indexOf(name);
  return index === -1 ? undefined : arguments_[index + 1];
};

export function parseDesktopPackageOptions(arguments_, hostPlatform = process.platform) {
  const platform = optionValue(arguments_, '--platform') ?? platformFromHost[hostPlatform];
  const arch = optionValue(arguments_, '--arch') ?? (platform === 'macos' ? 'universal' : 'x64');
  const dryRun = arguments_.includes('--dry-run');
  const smoke = dryRun || arguments_.includes('--smoke');

  if (!['macos', 'linux', 'windows'].includes(platform ?? '')) {
    throw new Error(
      `Unsupported desktop platform ${platform ?? '<unknown>'}. Use macos, linux, or windows.`
    );
  }

  const supportedArchitectures = {
    macos: ['universal', 'x64', 'arm64'],
    linux: ['x64'],
    windows: ['x64']
  };
  if (!supportedArchitectures[platform].includes(arch)) {
    throw new Error(
      `Unsupported ${platform} architecture ${arch}. Supported architectures: ${supportedArchitectures[
        platform
      ].join(', ')}.`
    );
  }

  return { platform, arch, dryRun, smoke };
}
