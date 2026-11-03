/** Compare resolved navigation paths, ignoring trailing slashes. */
export function navPathsMatch(resolvedPath: string, pathname: string): boolean {
	return resolvedPath.replace(/\/+$/, '') === pathname.replace(/\/+$/, '');
}
