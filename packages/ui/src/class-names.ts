export function classNames(...names: readonly (string | undefined)[]): string {
  return names.filter((name): name is string => name !== undefined && name.length > 0).join(' ');
}
