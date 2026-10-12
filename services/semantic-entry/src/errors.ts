export class SemanticError extends Error {
	constructor(
		public status: number,
		public code: string,
		public uncertain = false
	) {
		super(code);
	}
}
