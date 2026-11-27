import type { Lens } from 'liquid-gl';

export function liquidNav(surface: HTMLDivElement) {
	const mobile = matchMedia('(width < 48rem)');
	const reducedTransparency = matchMedia('(prefers-reduced-transparency: reduce)');
	const viewport = document.querySelector('main');
	const nav = surface.parentElement;
	if (!viewport || !nav) {
		return;
	}

	const refreshDelay = 150;
	let stop: (() => void) | undefined;

	const sync = () => {
		stop?.();
		stop = undefined;
		if (!mobile.matches || reducedTransparency.matches) {
			return;
		}

		let disposed = false;
		let revision = 0;
		let timeout: ReturnType<typeof setTimeout>;
		let lens: Lens | undefined;

		const refresh = () => {
			nav.classList.remove('refracting');
			const pending = ++revision;
			clearTimeout(timeout);
			const capture = async () => {
				const renderer = lens?.renderer;
				if (!renderer) {
					return;
				}
				const captured = await renderer.captureSnapshot().catch(() => false);
				if (disposed || pending !== revision) {
					return;
				}
				if (captured) {
					nav.classList.add('refracting');
				} else if (captured === undefined) {
					// liquidGL skips captures while a previous snapshot is still in progress.
					timeout = setTimeout(capture, refreshDelay);
				}
			};
			timeout = setTimeout(capture, refreshDelay);
		};

		const observer = new MutationObserver(refresh);
		observer.observe(viewport, { childList: true, characterData: true, subtree: true });
		observer.observe(document.documentElement, { attributeFilter: ['data-theme'] });
		viewport.addEventListener('scroll', refresh, { capture: true, passive: true });
		window.addEventListener('resize', refresh, { passive: true });

		void import('liquid-gl')
			.then(({ default: liquidGL }) => {
				if (disposed) {
					return;
				}
				lens = liquidGL({
					target: `#${surface.id}`,
					snapshot: 'body',
					content: false,
					resolution: 1,
					refraction: 0.015,
					bevelDepth: 0.15,
					bevelWidth: 0.22,
					frost: 0,
					shadow: false,
					specular: false,
					reveal: 'none',
					on: {
						init() {
							if (disposed) {
								return;
							}
							if (revision === 0) {
								nav.classList.add('refracting');
							} else {
								refresh();
							}
						}
					}
				});
			})
			.catch(() => {
				if (!disposed) {
					nav.classList.remove('refracting');
				}
			});

		stop = () => {
			disposed = true;
			clearTimeout(timeout);
			observer.disconnect();
			viewport.removeEventListener('scroll', refresh, true);
			window.removeEventListener('resize', refresh);
			lens?.destroy();
			nav.classList.remove('refracting');
		};
	};

	mobile.addEventListener('change', sync);
	reducedTransparency.addEventListener('change', sync);
	sync();

	return {
		destroy() {
			mobile.removeEventListener('change', sync);
			reducedTransparency.removeEventListener('change', sync);
			stop?.();
		}
	};
}
