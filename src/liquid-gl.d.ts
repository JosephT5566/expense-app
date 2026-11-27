declare module 'liquid-gl' {
	export interface Lens {
		destroy(): void;
		// The pinned 3.0.0 lens exposes its renderer, which refreshes the DOM snapshot.
		renderer: { captureSnapshot(): Promise<boolean | undefined> } | null;
	}

	export default function liquidGL(options: {
		target: string;
		snapshot: string;
		content: false;
		resolution: number;
		refraction: number;
		bevelDepth: number;
		bevelWidth: number;
		frost: number;
		shadow: boolean;
		specular: boolean;
		reveal: 'none';
		on: { init(): void };
	}): Lens | undefined;
}
