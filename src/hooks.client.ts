import * as Sentry from '@sentry/sveltekit';

Sentry.init({
	dsn: 'https://ae39209e991d8de787d76a8bec628446@o4511455035326464.ingest.us.sentry.io/4511455044632576',
	tracesSampleRate: 1.0,
	replaysSessionSampleRate: 0.1,
	replaysOnErrorSampleRate: 1.0
});

export const handleError = Sentry.handleErrorWithSentry();
