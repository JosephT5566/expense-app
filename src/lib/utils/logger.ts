import { isDev } from './helpers';

type LoggerOptions = {
	prod?: boolean;
};

function log(...args: Parameters<typeof console.log>): void;
function log(options: LoggerOptions, ...args: Parameters<typeof console.log>): void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function log(...args: any[]) {
	if (typeof args[0] === 'object' && !Array.isArray(args[0])) {
		const [options, ...rest] = args;
		if (options.prod) {
			console.log('[PROD LOG]', ...rest);
		}
	} else {
		if (!isDev) {
			return;
		}
		console.log('[DEV LOG]', ...args);
	}
}

function error(...args: Parameters<typeof console.error>): void;
function error(options: LoggerOptions, ...args: Parameters<typeof console.error>): void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function error(...args: any[]) {
	if (typeof args[0] === 'object' && !Array.isArray(args[0])) {
		const [options, ...rest] = args;
		if (options.prod) {
			console.error('[PROD ERROR]', ...rest);
		}
	} else {
		if (!isDev) {
			return;
		}
		console.error('[DEV ERROR]', ...args);
	}
}

function warn(...args: Parameters<typeof console.warn>): void;
function warn(options: LoggerOptions, ...args: Parameters<typeof console.warn>): void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function warn(...args: any[]) {
	if (typeof args[0] === 'object' && !Array.isArray(args[0])) {
		const [options, ...rest] = args;
		if (options.prod) {
			console.warn('[PROD WARN]', ...rest);
		}
	} else {
		if (!isDev) {
			return;
		}
		console.warn('[DEV WARN]', ...args);
	}
}

export default {
	log,
	error,
	warn,
};
