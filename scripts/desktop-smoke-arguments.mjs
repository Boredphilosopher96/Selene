export const desktopSmokeArguments = ({ executable, platform, environment = process.env }) => {
  const argumentsList = [executable, '--smoke-test'];
  const allowUnprivilegedLinuxSandboxBypass =
    platform === 'linux' &&
    environment.CI === 'true' &&
    environment.SELENE_DESKTOP_SMOKE_NO_SANDBOX === 'true';

  if (allowUnprivilegedLinuxSandboxBypass) argumentsList.push('--no-sandbox');
  return argumentsList;
};
